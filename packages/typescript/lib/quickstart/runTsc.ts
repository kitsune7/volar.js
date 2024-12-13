import * as fs from 'fs';
import * as path from 'path';
import type * as ts from 'typescript';
import type { Language, LanguagePlugin } from '@volar/language-core';

export let getLanguagePlugins: (ts: typeof import('typescript'), options: ts.CreateProgramOptions) => LanguagePlugin<string>[] | {
	languagePlugins: LanguagePlugin<string>[],
	setup?(language: Language<string>): void,
} = () => [];

export function runTsc(
	tscPath: string,
	options: string[] | {
		extraSupportedExtensions: string[];
		extraExtensionsToRemove: string[];
	},
	_getLanguagePlugins: typeof getLanguagePlugins,
	typescriptObject?: string
) {
	getLanguagePlugins = _getLanguagePlugins;

	const proxyApiPath = require.resolve('../node/proxyCreateProgram');
	const readFileSync = fs.readFileSync;

	(fs as any).readFileSync = (...args: any[]) => {
		if (args[0] === tscPath) {
			let tsc = (readFileSync as any)(...args) as string;

			// Support the tsc shim used in Typescript v5.7 and up
			if (!isMainTsc(tsc)) {
				const requireRegex = /module\.exports\s*=\s*require\((?:"|')(?<path>\.\/\w+\.js)(?:"|')\)/;
				const requirePath = requireRegex.exec(tsc)?.groups?.path;
				if (requirePath) {
					tsc = readFileSync(path.join(path.dirname(tscPath), requirePath), 'utf8');
				} else {
					throw new Error('Failed to locate tsc module path from shim');
				}
			}

			let extraSupportedExtensions: string[];
			let extraExtensionsToRemove: string[];
			if (Array.isArray(options)) {
				extraSupportedExtensions = options;
				extraExtensionsToRemove = [];
			}
			else {
				extraSupportedExtensions = options.extraSupportedExtensions;
				extraExtensionsToRemove = options.extraExtensionsToRemove;
			}

			return transformTscContent(tsc, proxyApiPath, extraSupportedExtensions, extraExtensionsToRemove, __filename, typescriptObject);
		}
		return (readFileSync as any)(...args);
	};

	try {
		require(tscPath);
	} finally {
		(fs as any).readFileSync = readFileSync;
		delete require.cache[tscPath];
	}
}

/**
 * Replaces the code of typescript to add support for additional extensions and language plugins.
 * 
 * @param tsc - The original code of typescript.
 * @param proxyApiPath - The path to the proxy API.
 * @param extraSupportedExtensions - An array of additional supported extensions.
 * @param extraExtensionsToRemove - An array of extensions to remove.
 * @param getLanguagePluginsFile - The file to get language plugins from.
 * @param typescriptObject - The object to use as typescript.
 * @returns The modified typescript code.
 */
export function transformTscContent(
	tsc: string,
	proxyApiPath: string,
	extraSupportedExtensions: string[],
	extraExtensionsToRemove: string[],
	getLanguagePluginsFile = __filename,
	typescriptObject = `new Proxy({}, { get(_target, p, _receiver) { return eval(p); } } )`
) {
	const neededPatchExtenstions = extraSupportedExtensions.filter(ext => !extraExtensionsToRemove.includes(ext));

	// Add allow extensions
	if (extraSupportedExtensions.length) {
		const extsText = extraSupportedExtensions.map(ext => `"${ext}"`).join(', ');
		tsc = replace(tsc, /supportedTSExtensions = .*(?=;)/, s => s + `.map((group, i) => i === 0 ? group.splice(0, 0, ${extsText}) && group : group)`);
		tsc = replace(tsc, /supportedJSExtensions = .*(?=;)/, s => s + `.map((group, i) => i === 0 ? group.splice(0, 0, ${extsText}) && group : group)`);
		tsc = replace(tsc, /allSupportedExtensions = .*(?=;)/, s => s + `.map((group, i) => i === 0 ? group.splice(0, 0, ${extsText}) && group : group)`);
	}
	// Use to emit basename.xxx to basename.d.ts instead of basename.xxx.d.ts
	if (extraExtensionsToRemove.length) {
		const extsText = extraExtensionsToRemove.map(ext => `"${ext}"`).join(', ');
		tsc = replace(tsc, /extensionsToRemove = .*(?=;)/, s => s + `.concat([${extsText}])`);
	}
	// Support for basename.xxx to basename.xxx.d.ts
	if (neededPatchExtenstions.length) {
		const extsText = neededPatchExtenstions.map(ext => `"${ext}"`).join(', ');
		tsc = replace(tsc, /function changeExtension\(/, s => `function changeExtension(path, newExtension) {
			return [${extsText}].some(ext => path.endsWith(ext))
				? path + newExtension
				: _changeExtension(path, newExtension)
			}\n` + s.replace('changeExtension', '_changeExtension'));
	}

	// proxy createProgram
	tsc = replace(tsc, /function createProgram\(.+\) {/, s =>
		`var createProgram = require(${JSON.stringify(proxyApiPath)}).proxyCreateProgram(`
		+ [
			typescriptObject,
			`_createProgram`,
			`require(${JSON.stringify(getLanguagePluginsFile)}).getLanguagePlugins`,
		].join(', ')
		+ `);\n`
		+ s.replace('createProgram', '_createProgram')
	);

	return tsc;
}

function isMainTsc(tsc: string) {
	// We assume it's the main tsc module if it has a `version` variable defined with a semver string
	const versionRegex = /(?:var|const|let)\s+version\s*=\s*(?:"|')\d+\.\d+\.\d+(?:"|')/;
	return versionRegex.test(tsc);
}

function replace(text: string, ...[search, replace]: Parameters<String['replace']>) {
	const before = text;
	text = text.replace(search, replace);
	const after = text;
	if (after === before) {
		throw 'Search string not found: ' + JSON.stringify(search.toString());
	}
	return after;
}
