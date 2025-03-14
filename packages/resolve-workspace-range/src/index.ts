import semver from 'semver'

export default function (range: string, versions: string[]) {
  if (range === '*' || range === '^' || range === '~') {
    return semver.maxSatisfying(versions, '*', {
      includePrerelease: true,
    })
  }
  return semver.maxSatisfying(versions, range, {
    loose: true,
  })
}
