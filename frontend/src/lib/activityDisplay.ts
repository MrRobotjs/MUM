import type {ActiveSession} from '../types/streaming';

const fields=['library_name','year','edition','parent_title','grandparent_title','player_title','player_platform','product','quality_detail','stream_detail','container_detail','video_detail','audio_detail','subtitle_detail','location_detail','location_ip','location_type_calc','bandwidth_detail','media_path','media_aspect_ratio','media_audio_codec','media_video_codec','media_video_resolution','media_container','media_video_frame_rate','media_video_profile'] as const;
const mediaNumbers=['media_duration','media_bitrate','media_width','media_height','media_audio_channels'] as const;
export type ActivityStreamDisplay=Partial<Pick<ActiveSession,typeof fields[number]|typeof mediaNumbers[number]|'state'|'raw_data_json'|'media_has_voice_activity'|'thumb_url'|'user_avatar_url'|'latitude'|'longitude'|'is_public_ip'|'is_transcode_calc'|'bitrate_calc'|'transcode_speed'|'transcode_throttled'>>;

export function readActivityDisplay(raw:unknown):ActivityStreamDisplay {
 if(!raw||typeof raw!=='object'||Array.isArray(raw))throw Error('Invalid stream details.');
 const value=raw as Record<string,unknown>,result:ActivityStreamDisplay={};
 if(value.state!==undefined){if(!['playing','paused','buffering'].includes(value.state as string))throw Error('Invalid playback state.');result.state=value.state as string;}
 if(value.raw_data_json!==undefined){const v=value.raw_data_json;if(typeof v!=='string'||v.length>8192||new TextEncoder().encode(v).length>8192)throw Error('Invalid stream diagnostics.');let parsed:unknown;try{parsed=JSON.parse(v);}catch{throw Error('Invalid stream diagnostics.');}if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw Error('Invalid stream diagnostics.');result.raw_data_json=v;}
 for(const key of fields){const v=value[key];if(v!==undefined){if(typeof v!=='string'||v.length>1024||v.trim()!==v||/[\u0000-\u001f\u007f]/.test(v))throw Error('Invalid stream detail.');result[key]=v;}}
 for(const key of ['is_transcode_calc','transcode_throttled','is_public_ip','media_has_voice_activity'] as const){const v=value[key];if(v!==undefined){if(typeof v!=='boolean')throw Error('Invalid stream state.');result[key]=v;}}
 for(const key of mediaNumbers){const v=value[key];if(v!==undefined){if(typeof v!=='number'||!Number.isSafeInteger(v)||v<=0||v>1e12)throw Error('Invalid media detail.');result[key]=v;}}
 for(const key of ['bitrate_calc','transcode_speed'] as const){const v=value[key];if(v!==undefined){if(typeof v!=='number'||!Number.isFinite(v)||v<0||v>1e12)throw Error('Invalid stream rate.');result[key]=v;}}
 if(value.thumb_url!==undefined){if(typeof value.thumb_url!=='string'||value.thumb_url.length>2048||!/^\/api\/activity\/images\/[1-9][0-9]*\?[^#\s]+$/.test(value.thumb_url))throw Error('Invalid stream poster.');result.thumb_url=value.thumb_url;}
 if(value.user_avatar_url!==undefined){if(typeof value.user_avatar_url!=='string'||value.user_avatar_url.length>2048||!/^\/api\/activity\/avatars\/[1-9][0-9]*\?[^#\s]+$/.test(value.user_avatar_url))throw Error('Invalid stream avatar.');result.user_avatar_url=value.user_avatar_url;}
 if(value.latitude!==undefined||value.longitude!==undefined){const lat=value.latitude,lon=value.longitude;if(typeof lat!=='number'||typeof lon!=='number'||!Number.isFinite(lat)||!Number.isFinite(lon)||lat < -90||lat>90||lon < -180||lon>180||value.is_public_ip!==true)throw Error('Invalid public stream coordinates.');result.latitude=lat;result.longitude=lon;}
 return result;
}
