export type LocalDataProfileId = 'production' | 'development';

export interface LocalDataProfile {
  id: LocalDataProfileId;
  label: string;
  current: boolean;
  exists: boolean;
  running: boolean;
  path: string;
  blockedReason?: string;
}

export interface LocalDataProfiles {
  currentProfile: LocalDataProfileId;
  profiles: LocalDataProfile[];
}

export interface LocalDataEraseRequest {
  profile: LocalDataProfileId;
  confirmation: string;
}

export type LocalDataResult<T> = { success: true; data: T } | { success: false; error: string };

export interface LocalDataAPI {
  getProfiles(): Promise<LocalDataResult<LocalDataProfiles>>;
  erase(request: LocalDataEraseRequest): Promise<LocalDataResult<{ restarting: boolean; requiresManualStart?: boolean }>>;
}
