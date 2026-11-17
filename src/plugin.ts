import type {API} from 'homebridge';
import {HeatingProgrammesPlatform, PLATFORM_NAME} from './platform';

export = (api: API) => {api.registerPlatform(PLATFORM_NAME, HeatingProgrammesPlatform);};
