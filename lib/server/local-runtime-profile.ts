export type LocalRuntimeProfile = 'mac-mlx' | 'windows-cuda' | 'generic';

export interface LocalRuntimeCapabilities {
  profile: LocalRuntimeProfile;
  platform: NodeJS.Platform;
  arch: string;

  llm: {
    available: boolean;
    backend: 'ollama';
  };

  image: {
    available: boolean;
    backend: 'vmlx' | 'comfyui' | 'none';
  };

  video: {
    available: boolean;
    backend: 'comfyui' | 'none';
  };

  speech: {
    available: boolean;
    backend: 'docker';
  };

  recommendedClassComplexity: 'small' | 'medium' | 'high';
}

function detectAutomaticProfile(): LocalRuntimeProfile {
  if (process.platform === 'darwin' && process.arch === 'arm64') {
    return 'mac-mlx';
  }

  if (process.platform === 'win32') {
    return 'windows-cuda';
  }

  return 'generic';
}

export function getLocalRuntimeProfile(): LocalRuntimeProfile {
  const configured = process.env.LOCAL_PROFILE?.trim().toLowerCase();

  if (configured === 'mac-mlx' || configured === 'windows-cuda' || configured === 'generic') {
    return configured;
  }

  return detectAutomaticProfile();
}

export function getLocalRuntimeCapabilities(): LocalRuntimeCapabilities {
  const profile = getLocalRuntimeProfile();

  switch (profile) {
    case 'mac-mlx':
      return {
        profile,
        platform: process.platform,
        arch: process.arch,

        llm: {
          available: true,
          backend: 'ollama',
        },

        image: {
          available: true,
          backend: 'vmlx',
        },

        video: {
          available: false,
          backend: 'none',
        },

        speech: {
          available: true,
          backend: 'docker',
        },

        recommendedClassComplexity: 'medium',
      };

    case 'windows-cuda':
      return {
        profile,
        platform: process.platform,
        arch: process.arch,

        llm: {
          available: true,
          backend: 'ollama',
        },

        image: {
          available: true,
          backend: 'comfyui',
        },

        video: {
          available: true,
          backend: 'comfyui',
        },

        speech: {
          available: true,
          backend: 'docker',
        },

        recommendedClassComplexity: 'high',
      };

    default:
      return {
        profile,
        platform: process.platform,
        arch: process.arch,

        llm: {
          available: true,
          backend: 'ollama',
        },

        image: {
          available: false,
          backend: 'none',
        },

        video: {
          available: false,
          backend: 'none',
        },

        speech: {
          available: true,
          backend: 'docker',
        },

        recommendedClassComplexity: 'small',
      };
  }
}
