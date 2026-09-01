export function isReleaseCommit(commitMessage) {
  return /\[release\]/i.test(commitMessage);
}
