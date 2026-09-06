import semver from 'semver';

export function isNewerReleaseVersion(candidate, current) {
  if (!semver.valid(candidate)) {
    throw new Error(`The release feed returned an invalid version: ${candidate || '(missing)'}`);
  }
  if (!semver.valid(current)) {
    throw new Error(`The installed app has an invalid version: ${current || '(missing)'}`);
  }
  return semver.gt(candidate, current);
}
