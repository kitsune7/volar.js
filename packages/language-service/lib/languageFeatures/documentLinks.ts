import { forEachEmbeddedFile } from '@volar/language-core';
import type * as vscode from 'vscode-languageserver-protocol';
import type { ServiceContext } from '../types';
import { NoneCancellationToken } from '../utils/cancellation';
import { notEmpty } from '../utils/common';
import { documentFeatureWorker } from '../utils/featureWorkers';
import { transformDocumentLinkTarget } from './documentLinkResolve';

export interface DocumentLinkData {
	uri: string,
	original: Pick<vscode.DocumentLink, 'data'>,
	serviceIndex: number,
}

export function register(context: ServiceContext) {

	return async (uri: string, token = NoneCancellationToken) => {

		const pluginLinks = await documentFeatureWorker(
			context,
			uri,
			file => !!file.capabilities.documentSymbol,
			async (service, document) => {

				if (token.isCancellationRequested)
					return;

				const links = await service.provideDocumentLinks?.(document, token);

				for (const link of links ?? []) {
					link.data = {
						uri,
						original: {
							data: link.data,
						},
						serviceIndex: context.services.indexOf(service),
					} satisfies DocumentLinkData;
				}

				return links;
			},
			(links, map) => links.map(link => {

				if (!map)
					return link;

				const range = map.toSourceRange(link.range);
				if (!range)
					return;

				link = {
					...link,
					range,
				};

				if (link.target)
					link.target = transformDocumentLinkTarget(link.target, context);

				return link;
			}).filter(notEmpty),
			arr => arr.flat(),
		) ?? [];

		return [
			...pluginLinks,
			...getFictitiousLinks(),
		];

		function getFictitiousLinks() {

			const result: vscode.DocumentLink[] = [];
			const sourceFile = context.project.fileProvider.getSourceFile(uri);

			if (sourceFile?.root) {
				const document = context.documents.get(uri, sourceFile.languageId, sourceFile.snapshot);
				for (const virtualFile of forEachEmbeddedFile(sourceFile.root)) {
					for (const [_, [sourceSnapshot, map]] of context.project.fileProvider.getMaps(virtualFile)) {
						if (sourceSnapshot === sourceFile.snapshot) {
							for (const mapped of map.mappings) {

								if (!mapped.data.displayWithLink)
									continue;

								if (mapped.sourceRange[0] === mapped.sourceRange[1])
									continue;

								result.push({
									range: {
										start: document.positionAt(mapped.sourceRange[0]),
										end: document.positionAt(mapped.sourceRange[1]),
									},
									target: uri, // TODO
								});
							}
						}
					}
				}
			}

			return result;
		}
	};
}
