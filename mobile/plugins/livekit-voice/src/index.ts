import { registerPlugin } from '@capacitor/core';

import type { LiveKitVoicePlugin } from './definitions';

const LiveKitVoice = registerPlugin<LiveKitVoicePlugin>('LiveKitVoice', {
  web: () => import('./web').then((m) => new m.LiveKitVoiceWeb()),
});

export * from './definitions';
export { LiveKitVoice };
