const PLAYER_TICK_INTERVAL_SECONDS = 3;
const PLAYER_TICK_INTERVAL = PLAYER_TICK_INTERVAL_SECONDS * 1000;
const NO_OP = function(){};

var Stream = require('stream');

var es = require('event-stream');
var _ = require('underscore');
var uuid = require('node-uuid');
var EngineServer = require('engine.io-stream');

var http_server;
var rooms = [];

var generateAuthToken = require('../utils/generateAuthToken.js');

var Room = function( data, options ){

	var room = this;

	// give the room an id
	this.id = uuid.v4();

	// set up default data
	this.data = {
		id: this.id,
		name: 'Default Room Name',
		player: {
			order: 'fifo'
		},
		users: [],
		playlist: []
	};

	// extend data with passed in data
	this.data = _.extend( this.data, data );

	// create stream for all room data
	this.stream = new Stream.Duplex({ objectMode: true });
	this.stream._read = function(){
	};
	this.stream._write = function( chunk, encoding, next ){
		this.push( chunk );
		next();
	};

	this.stream.on( 'data', function( data ){
		if( data.module === 'playlist' ){
			switch( data.type ){
			case 'add':
				data.payload.user = data.user;
				room.addItem( data.payload );
			break;
			case 'remove':
				room.removeItem( data.payload );
			break;
			}
		}
		else if( data.module === 'player' ){
			switch( data.type ){
			case 'skip':
				room.nextItem();
			break;
			case 'order':
				room.setOrder( data.payload );
			break;
			}
		}
	});

	// set up engine.io streams
	// this is where user connections are made
	var engine = EngineServer( function( stream ){
		var sid = stream.transport.sid;
		// stringify outgoing messages
		// parse incoming messages
		var stringify_stream = es.stringify();
		stringify_stream.pipe( stream );
		stream = es.duplex( stringify_stream, stream.pipe( es.parse() ) );
		// check user validity
		// close user connection if no auth sent in time
		var revokeAuth = function( reason ){
			reason = reason || 'Authentication error';
			stream.write({
				module: 'notifications',
				type: 'error',
				payload: {
					message: reason
				}
			});
			stream.end();
		};
		var checkAuth = function( id, name, token ){
			return generateAuthToken( id, name ) === token;
		};
		var auth_timeout = setTimeout( function(){
			revokeAuth('Authentication timed out');
		}, 15 * 1000 );
		stream.once( 'data', function( data ){
			if( data.type === 'auth' ){
				var id = data.payload.id;
				var name = data.payload.name;
				var token = data.payload.token;
				if( checkAuth( id, name, token ) ){
					clearTimeout( auth_timeout );
					// stream connection stream into room stream
					// stream room stream into connection stream
					stream
						// attach user data
						.pipe( es.through( function( data ){
							data.user = {
								id: id,
								name: name
							};
							// attach item data to skip events
							if( data.type === 'skip' ){
								data.item = room.data.player.item;
							}
							this.queue( data );
						}))
						.pipe( room.stream )
						.pipe( stream );
					// send existing presences
					stream.write({
						module: 'presences',
						type: 'list',
						payload: {
							users: room.data.users
						}
					});
					// user join/leave
					var presence = {
						id: id,
						name: name,
						sid: sid
					};
					var presences = room.addPresence( presence );
					// if there's only one presence this is a new user
					if( presences === 1 ){
						room.stream.write({
							module: 'presences',
							type: 'join',
							payload: {
								user: presence
							}
						});
					}
					stream.on('close', function(){
						var presences = room.removePresence( presence );
						// if there are no presences this user has left
						if( presences === 0 ){
							room.stream.write({
								module: 'presences',
								type: 'leave',
								payload: {
									user: presence
								}
							});
						}
					});
					// send existing playlist
					stream.write({
						module: 'playlist',
						type: 'list',
						payload: room.data.playlist
					});
					// send existing player
					stream.write({
						module: 'player',
						type: 'state',
						payload: room.data.player
					});
				}
				else {
					revokeAuth();
				}
			}
		});
	});
	engine.attach( http_server, '/streaming/rooms/'+ room.id );

	// add room instance to rooms collection
	rooms.push( room );

};

Room.list = function( convert ){
	if( convert ){
		return rooms.map( function( room ){
			return room.data;
		});
	}
	return rooms;
}

Room.findById = function( id, convert ){
	var room = _.find( rooms, function( room ){
		return room.id === id;
	});
	if( convert ){
		return room.data;
	}
	return room;
};

// add a user presence
Room.prototype.addPresence = function( presence ){
	var sessions;
	// check to see if id exists
	var existing_user = _.find( this.data.users, function( user ){
		return user.id === presence.id;
	});
	// if id exists, add sid to sids array
	if( existing_user ){
		existing_user.sids.push( presence.sid );
		sessions = existing_user.sids.length;
	}
	// if id does not exist, add new user to users array
	else {
		this.data.users.push({
			id: presence.id,
			name: presence.name,
			sids: [ presence.sid ]
		});
		sessions = 1;
	}
	return sessions;
};

// remove a user presence
Room.prototype.removePresence = function( presence ){
	// find user with id
	var existing_user = _.find( this.data.users, function( user ){
		return user.id === presence.id;
	});
	if( !existing_user ) return new Error('No user '+ presence.id );
	// remove sid
	existing_user.sids = _.without( existing_user.sids, presence.sid );
	// if sids.length === 0 remove user from users array
	if( existing_user.sids.length === 0 ){
		this.data.users = _.without( this.data.users, existing_user );
	}
	return existing_user.sids.length;
};

Room.prototype.addItem = function( item ){
	item.id = uuid.v4();
	this.data.playlist.push( item );
	if( !this.data.player.item ) this.nextItem();
	return item;
};

Room.prototype.removeItem = function( id, write_to_stream ){
	var item = _.findWhere( this.data.playlist, { id: id } );
	this.data.playlist = _.without( this.data.playlist, item );
	if( write_to_stream ){
		this.stream.write({
			module: 'playlist',
			type: 'remove',
			payload: id
		});
	}
	return item;
};

Room.prototype.playItem = function( item ){
	// reset timer
	if( this.player_interval ) clearInterval( this.player_interval );
	this.data.player.elapsed = 0;
	// clear player if we're playing nothing
	if( !item ){
		this.data.player.item = null;
	}
	// set item and start player interval
	else {
		this.data.player.item = item;
		this.player_interval = setInterval( function(){
			this.data.player.elapsed += PLAYER_TICK_INTERVAL_SECONDS;
			if( this.data.player.elapsed >= this.data.player.item.duration ){
				this.nextItem();
			}
			else {
				this.stream.write({
					module: 'player',
					type: 'elapsed',
					payload: this.data.player.elapsed
				});
			}
		}.bind( this ), PLAYER_TICK_INTERVAL );
	}
	this.stream.write({
		module: 'player',
		type: 'play',
		payload: item
	});
};

Room.prototype.nextItem = function(){
	var current_item = this.data.player.item;
	var next_item;
	switch( this.data.player.order ){
		case 'fifo':
			next_item = this.data.playlist[0];
		break;
		case 'shuffle':
			next_item = _.sample( this.data.playlist );
		break;
	}
	if( next_item ){
		this.removeItem( next_item.id, true );
	}
	this.playItem( next_item );
};

Room.prototype.setOrder = function( order ){
	order = order || 'fifo';
	var orders = ['fifo','shuffle'];
	if( orders.indexOf( order ) < 0 ) return new Error('Invalid order '+ order);
	this.data.player.order = order;
	return order;
}

// export a function so we can pass in http_server instance
module.exports = function( config ){
	http_server = config.http_server;
	return Room;
};