/**
 * Builds the GitHub Pages site into site/:
 *
 *   site/<tag>/claim-chat-assistant.js       minified ES module, one folder per v* tag
 *   site/<tag>/claim-chat-assistant.js.map
 *   site/<tag>/claim-chat-fragments.zip      fragment collection, importable in Fragments admin
 *   site/latest/...                          same files, built from HEAD
 *   site/index.html                          list of versions and the URLs to copy
 *
 * Every tag is rebuilt from git on each run: a Pages deployment replaces the
 * whole site, so older versions must be part of every deployment to keep
 * their URLs working.
 */

import {execFileSync} from 'node:child_process';
import {mkdirSync, rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';

import {transform} from 'esbuild';

const MODULE = 'claim-chat-assistant.js';
const FRAGMENTS_ZIP = 'claim-chat-fragments.zip';
const SITE = 'site';

const repository = process.env.GITHUB_REPOSITORY || 'fabian-bouche-liferay/ai-hub-claim-chat-assistant';
const [owner, name] = repository.split('/');
const baseURL = `https://${owner}.github.io/${name}`;

function git(...args) {
	return execFileSync('git', args, {encoding: 'utf8', maxBuffer: 16 * 1024 * 1024});
}

async function buildVersion(ref, version) {
	const directory = join(SITE, version);

	mkdirSync(directory, {recursive: true});

	const {code, map} = await transform(git('show', `${ref}:src/${MODULE}`), {
		banner: `/* ${MODULE} ${version} - https://github.com/${repository} */`,
		format: 'esm',
		minify: true,
		sourcefile: MODULE,
		sourcemap: 'external',
		target: 'es2020',
	});

	writeFileSync(join(directory, MODULE), `${code}//# sourceMappingURL=${MODULE}.map\n`);
	writeFileSync(join(directory, `${MODULE}.map`), map);

	git('archive', '--format=zip', `--output=${join(directory, FRAGMENTS_ZIP)}`, `${ref}:fragments`);

	console.log(`Built ${version} from ${ref}`);
}

function indexPage(versions) {
	const rows = versions
		.map(
			(version) => `
			<tr>
				<td>${version}</td>
				<td><code>${baseURL}/${version}/${MODULE}</code></td>
				<td><a href="${version}/${FRAGMENTS_ZIP}">${FRAGMENTS_ZIP}</a></td>
			</tr>`
		)
		.join('');

	return `<!doctype html>
<html lang="en">
<head>
	<meta charset="utf-8">
	<meta name="viewport" content="width=device-width, initial-scale=1">
	<title>Claim Chat Assistant</title>
	<style>
		body { background: #fff; color: #272833; font-family: system-ui, sans-serif; margin: 0 auto; max-width: 960px; padding: 16px; }
		table { border-collapse: collapse; width: 100%; }
		td, th { border-bottom: 1px solid #e7e7ed; padding: 8px; text-align: left; }
		code { word-break: break-all; }
	</style>
</head>
<body>
	<h1>Claim Chat Assistant</h1>
	<p>
		In Liferay, create a <strong>JS Import Maps Entry</strong> client extension with the bare specifier
		<code>claim-chat-assistant</code> and one of the URLs below. Then import the fragment collection
		in Design &rarr; Fragments.
	</p>
	<p>Source and documentation: <a href="https://github.com/${repository}">github.com/${repository}</a></p>
	<table>
		<thead><tr><th>Version</th><th>JavaScript URL</th><th>Fragments</th></tr></thead>
		<tbody>${rows}
		</tbody>
	</table>
</body>
</html>
`;
}

rmSync(SITE, {force: true, recursive: true});

const tags = git('tag', '--list', 'v*', '--sort=-version:refname').split('\n').filter(Boolean);

for (const tag of tags) {
	await buildVersion(tag, tag);
}

await buildVersion('HEAD', 'latest');

writeFileSync(join(SITE, 'index.html'), indexPage(['latest', ...tags]));

// Serve files as-is: no Jekyll processing on GitHub Pages.
writeFileSync(join(SITE, '.nojekyll'), '');
