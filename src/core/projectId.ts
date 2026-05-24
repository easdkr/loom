const ULID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function encodeTime(time: number): string {
  let value = Math.max(0, Math.floor(time));
  let output = "";
  for (let index = 0; index < 10; index += 1) {
    output = ULID_ALPHABET[value % 32] + output;
    value = Math.floor(value / 32);
  }
  return output;
}

function encodeRandom(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let output = "";
  for (let index = 0; index < 16; index += 1) {
    output += ULID_ALPHABET[bytes[index] % 32];
  }
  return output;
}

export function createProjectId(): string {
  return `${encodeTime(Date.now())}${encodeRandom()}`;
}

export function scopeProjectId(projectId: string, localId: string): string {
  return localId.includes(":") ? localId : `${projectId}:${localId}`;
}

export function splitProjectScopedId(fullId: string): { projectId: string; localId: string } {
  const index = fullId.indexOf(":");
  if (index <= 0) {
    return { projectId: "", localId: fullId };
  }
  return {
    projectId: fullId.slice(0, index),
    localId: fullId.slice(index + 1),
  };
}
