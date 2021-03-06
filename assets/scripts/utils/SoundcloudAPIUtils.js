import url from 'url';
import jsonp from 'jsonp';
import xhr from 'xhr';

import SearchServerActionCreator from '../actions/SearchServerActionCreator.js';

var NO_OP = function(){};
var REQUEST_TIMEOUT = 15;
var SOUNDCLOUD_CLIENT_ID = tandem.bridge.apis.soundcloud.client_id;
var SOUNDCLOUD_API_HOST = 'api.soundcloud.com';
var SOUNDCLOUD_API_PROXY_PATH = '/api/v1/proxy/soundcloud';

var _processSoundcloudItem = function( item ){
	var stream_url = `${item.stream_url}?consumer_key=${SOUNDCLOUD_CLIENT_ID}`;
	// Get an image to represent this track
	// If it doesn't have artwork, use the user's avatar
	// Then make sure we get the biggest version of the image
	var image = ( item.artwork_url || item.user.avatar_url );
	image = image
		? image.replace( 'large', 'crop' )
		: 'https://s3-us-west-1.amazonaws.com/syncmedia/images/null.png';
	var processed_item = {
		original_id: item.id,
		title: item.title,
		url: item.permalink_url,
		media_url: stream_url,
		source: 'soundcloud',
		image: image,
		type: 'audio',
		duration: parseInt( ( item.duration / 1000 ), 10 ),
		artist: item.user.username,
		artist_url: item.user.permalink_url
	};
	return processed_item;
};

var _processSoundcloudResults = function( results ){
	var processed_results = results.map( result => {
		var image = ( result.artwork_url || result.user.avatar_url );
		image = image
			? image.replace( 'large', 'crop' )
			: 'https://s3-us-west-1.amazonaws.com/syncmedia/images/null.png';
		var processed_result = {
			original_id: result.id,
			title: result.title,
			url: result.permalink_url,
			description: result.description,
			author: result.user.username,
			date: result.created_at,
			image: image,
			duration: result.duration / 1000,
			plays: result.playback_count,
			embeddable: result.streamable,
			source: 'soundcloud'
		};
		return processed_result;
	});
	return processed_results;
};

var SoundcloudAPIUtils = {
	testUrl: function( url_to_test ){
		return /.*soundcloud\.com\/.*/i.test( url_to_test );
	},
	getItemFromUrl: function( item_url, callback = NO_OP ){
		var resolve_url = url.format({
			host: SOUNDCLOUD_API_HOST,
			pathname: 'resolve.json',
			query: {
				client_id: SOUNDCLOUD_CLIENT_ID,
				url: item_url
			}
		});
		jsonp( resolve_url, {
			timeout: REQUEST_TIMEOUT * 1000
		}, ( error, data ) => {
			if( error ){
				return callback( new Error('Error resolving url with SoundCloud.') );
			}
			else if( data.kind !== 'track' ){
				return callback( new Error('Invalid SoundCloud URL. Must be a SoundCloud track (no sets for now).') );
			}
			else if( !data.streamable ){
				return callback( new Error('Streaming has been disabled for this track! Nooo :(') );
			}
			var item = _processSoundcloudItem( data );
			return callback( null, item );
		});
	},
	startSearch: function( query ){
		var search_url = url.format({
			host: SOUNDCLOUD_API_HOST,
			pathname: 'tracks.json',
			query: {
				client_id: SOUNDCLOUD_CLIENT_ID,
				filter: 'streamable',
				limit: 30,
				offset: 0,
				q: query
			}
		});
		jsonp( search_url, {
			timeout: REQUEST_TIMEOUT * 1000
		}, ( err, data ) => {
			if( err ){
				alert('SoundCloud search error');
				return;
			}
			var results = _processSoundcloudResults( data );
			SearchServerActionCreator.receiveResults( results, 'soundcloud' );
		});
	},
	likeItem: function( item_id, callback = NO_OP ){
		xhr({
			url: `${SOUNDCLOUD_API_PROXY_PATH}/me/favorites/${item_id}`,
			method: 'PUT'
		}, callback );
	}
};

export default SoundcloudAPIUtils;
