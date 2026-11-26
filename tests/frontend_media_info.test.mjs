import assert from 'node:assert/strict';
import test from 'node:test';
import {loadFrontend} from './frontendLoader.mjs';
const load=()=>loadFrontend("export * from './src/lib/mediaInfo';");

test('media info card reads only plausible saved file details',async()=>{
 const m=await load();
 assert.equal(m.readMediaInfo(null),null);
 assert.equal(m.readMediaInfo({}),null);
 assert.deepEqual(m.readMediaInfo({container:'MKV',bitrate_kbps:9861,video_codec:'HEVC',video_resolution:'1080p',video_frame_rate:'24p',audio_codec:'EAC3',audio_channels:6,size_bytes:8800000000}),
  {container:'MKV',video_codec:'HEVC',video_resolution:'1080p',video_frame_rate:'24p',audio_codec:'EAC3',bitrate_kbps:9861,audio_channels:6,size_bytes:8800000000});
 for(const bad of [[],'MKV',{container:''},{container:' MKV'},{container:'x'.repeat(33)},{bitrate_kbps:0},{audio_channels:2.5},{size_bytes:'1'}])assert.throws(()=>m.readMediaInfo(bad));
 assert.deepEqual(m.readMediaInfo({container:'MKV',extra:'ignored'}),{container:'MKV'});
});

test('media info labels',async()=>{
 const m=await load();
 assert.equal(m.audioChannelsLabel(2),'Stereo');assert.equal(m.audioChannelsLabel(6),'5.1');assert.equal(m.audioChannelsLabel(8),'7.1');assert.equal(m.audioChannelsLabel(3),'3 channels');
 assert.equal(m.mediaBitrateLabel(9861),'9.9 Mbps');assert.equal(m.mediaBitrateLabel(640),'640 Kbps');
 assert.equal(m.mediaSizeLabel(8800000000),'8.8 GB');
});
