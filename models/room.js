const TOKEN_SECRET = process.env.QUICKSYNC_TOKEN_SECRET;
const NO_OP = function(){};

var Stream = require('stream');
var crypto = require('crypto');

var es = require('event-stream');
var _ = require('underscore');
var uuid = require('node-uuid');
var EngineServer = require('engine.io-stream');

var http_server;
var rooms = [];

// generate auth token for use with streaming endpoints
// pass any data we need attached to message objects
var generateAuthToken = function( id, name ){
	var hmac = crypto.createHmac( 'sha256', TOKEN_SECRET );
	hmac.setEncoding('hex');
	hmac.write( id );
	hmac.write( name );
	hmac.end();
	return hmac.read();
};

var Room = function( data, options ){

	var room = this;

	// give the room an id
	this.id = uuid.v4();

	// set up default data
	this.data = {
		id: this.id,
		name: 'Default Room Name',
		player: {},
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
							this.queue( data );
						}))
						.pipe( room.stream )
						.pipe( stream );
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
		this.data.users = _.without( this.users, existing_user );
	}
	return existing_user.sids.length;
};

// export a function so we can pass in http_server instance
module.exports = function( config ){
	http_server = config.http_server;
	return Room;
};