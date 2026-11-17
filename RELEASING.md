# Releasing whycrash

## Pre-publish checklist

- [ ] `package.json` has `repository`, `homepage`, `bugs` and (optionally) `author`
      pointing at the real GitHub repository (see "First release" below)
- [ ] `CHANGELOG.md` has an entry for the new version with today's date
- [ ] Version bumped (`npm version patch|minor|major --no-git-tag-version`)
- [ ] `npm run check` passes locally (types, lint, format, tests, packed-tarball smoke test,
      publint and Are-The-Types-Wrong)
- [ ] CI is green on `main` (including the Node.js 18/20 compatibility job and Windows)
- [ ] `npm pack --dry-run` lists only `dist/`, `README.md`, `LICENSE`, `CHANGELOG.md`
      and `package.json`
- [ ] Logged in to the right npm account (`npm whoami`), with 2FA enabled

## Commands

```sh
# 1. Install dependencies (exact versions from the lockfile)
npm ci

# 2. Run the tests (builds first, then runs the Vitest suite)
npm test

# 3. Build the package
npm run build

# 4. Inspect the tarball
npm pack --dry-run          # list files and sizes
npm run test:package        # install the real tarball in a temp project and smoke-test it
npm run check:exports       # publint + Are The Types Wrong

# 5. Log in to npm
npm login
npm whoami

# 6. Publish (prepublishOnly runs `npm run check` again)
npm publish --access public
```

## First release

1. Create the GitHub repository (suggested name: `whycrash`) and push:

   ```sh
   git add -A
   git commit -m "Initial release"
   git remote add origin git@github.com:<you>/whycrash.git
   git push -u origin main
   ```

2. Add the repository metadata (replace `<you>`):

   ```sh
   npm pkg set repository.type=git repository.url=git+https://github.com/<you>/whycrash.git
   npm pkg set homepage=https://github.com/<you>/whycrash#readme
   npm pkg set bugs.url=https://github.com/<you>/whycrash/issues
   npm pkg set author="Your Name"
   ```

3. Check the name is still free: `npm view whycrash` should return `404 Not Found`.

## After publishing

```sh
git tag v0.1.0
git push --tags
```

Then create a GitHub release from the tag, pasting the CHANGELOG entry.

Optional, recommended once the repo is on GitHub: publish from CI with
[npm trusted publishing / provenance](https://docs.npmjs.com/generating-provenance-statements)
(`npm publish --provenance`) so users can verify the package was built from this repository.
