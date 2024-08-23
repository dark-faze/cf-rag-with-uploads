//@ts-nocheck

import { Ai } from '@cloudflare/ai';
import { Hono } from 'hono';

import ui from './pages/ui.html';
import upload from './pages/upload.html';
import uploadText from './pages/uploadText.html';

import { extractText, getDocumentProxy } from 'unpdf';
import { Document } from 'langchain/document';
import { RecursiveCharacterTextSplitter } from 'langchain/text_splitter';
import * as cheerio from 'cheerio';

import { extractTextContent } from './helpers/webpageFormatter';
import { isUrl, isPdfLink } from './helpers/fileType';

interface Env {
	DB: D1Database;
	QUEUE: Queue;
	VECTORIZE: VectorizeIndex;
	AI: Ai;
}

const app = new Hono<{ Bindings: Env }>();

app.get('/', (c) => {
	return c.html(ui);
});

app.get('/addFromLink', (c) => {
	return c.html(upload);
});

app.get('/addFromText',(c) => {
	return c.html(uploadText);
});

app.get('/query', async (c: any) => {
	const ai = c.env.AI;
	const question = c.req.query('text');

	const { data } = await ai.run('@cf/baai/bge-base-en-v1.5', { text: question });
	const vectors = data[0];

	const SIMILARITY_CUTOFF = 0.65;
	const vectorQuery = await c.env.VECTORIZE.query(vectors, { topK: 100 }); // Increase topK
	const vecIds = vectorQuery.matches
		.filter((vec) => vec.score > SIMILARITY_CUTOFF)
		.slice(0, 3) // Limit to 5 results after filtering
		.map((vec) => vec.id);

	let notes = [];
	if (vecIds.length) {
		const query = `SELECT * FROM texts WHERE id IN (${vecIds.join(', ')})`;
		const { results } = await c.env.DB.prepare(query).bind().all();
		if (results) notes = results.map((vec) => vec.text);
	}

	const contextMessage = notes.length ? `Context:\n${notes.map((note) => `- ${note}`).join('\n')}` : '';
	const systemPrompt = `When answering the question or responding, use the context provided, if it is provided and relevant.`;

	const { response: answer } = await ai.run('@cf/meta/llama-3-8b-instruct', {
		messages: [
			...(notes.length ? [{ role: 'system', content: contextMessage }] : []),
			{ role: 'system', content: systemPrompt },
			{ role: 'user', content: question },
		],
	});

	return c.text(answer);
});

app.post('/uploadLink', async (c: any) => {
	let allChunks = [];
	const ai = c.env.AI;
	const { text } = await c.req.json();

	if (isUrl(text)) {

		const response = await fetch(text);
		const htmlContent = await response.text();
		const $ = cheerio.load(htmlContent);

		const pageData = extractTextContent($);
		const result = pageData.join(' ');

		let doc = new Document({ pageContent: result, metadata: { source: text } });

		const splitter = new RecursiveCharacterTextSplitter({
			chunkSize: 1000,
			chunkOverlap: 200,
		});

		const chunks = await splitter.splitDocuments([doc]);

		allChunks.push(...chunks);
	} else if (isPdfLink(text)) {
		const buffer = await fetch(text).then((res) => res.arrayBuffer());

		const pdf = await getDocumentProxy(new Uint8Array(buffer));
		const totalPages = pdf.numPages;

		for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
			const page = await pdf.getPage(pageNum);
			const text = await page.getTextContent();

			// Extract plain text from the page content
			const pageText = text.items.map((item: any) => item.str).join(' ');

			// Split the text into chunks while retaining the page number
			const splitter = new RecursiveCharacterTextSplitter({
				chunkSize: 1000,
				chunkOverlap: 200,
			});
			const chunks = await splitter.splitDocuments([new Document({ pageContent: pageText, metadata: { page: pageNum } })]);
			allChunks.push(...chunks);
		}
	} else {
		return c.json({ error: 'Invalid input' });
	}

	// Queue the chunks in batches because the queue has a limit of 100 messages per batch
	const batchSize = 100;
	const totalChunks = allChunks.length;
	let batchCount = 0;

	for (let i = 0; i < totalChunks; i += batchSize) {
		const batch = allChunks.slice(i, i + batchSize).map((value) => ({
			body: JSON.stringify(value),
		}));

		await c.env.QUEUE.sendBatch(batch);
		batchCount++;
	}

	return c.json({ data: 'OK', allChunks });
});

app.post('/uploadText', async (c: any) => {
	const { text } = await c.req.json();

	const { results } = await c.env.DB.prepare('INSERT INTO texts (text) VALUES (?) RETURNING *').bind(text).run();
	const record = results.length ? results[0] : null;
	console.log(record);
	// Split the text into chunks
	const splitter = new RecursiveCharacterTextSplitter({
		chunkSize: 1000,
		chunkOverlap: 200,
	});
	const chunks = await splitter.splitDocuments([new Document({ pageContent: text })]);

	// Queue the chunks in batches
	const batchSize = 100;
	const totalChunks = chunks.length;

	for (let i = 0; i < totalChunks; i += batchSize) {
		const batch = chunks.slice(i, i + batchSize).map((chunk) => ({
			body: JSON.stringify(chunk),
		}));

		await c.env.QUEUE.sendBatch(batch);
	}

	return c.json({ data: 'OK', record });
});

export default {
	fetch: app.fetch,
	async queue(batch: any, env: any) {
		for (const message of batch.messages) {
			try {
				let chunk = message.body;
				chunk = JSON.parse(chunk);
				const { results } = await env.DB.prepare('INSERT INTO texts (text) VALUES (?) RETURNING *').bind(chunk.pageContent).run();
				const record = results.length ? results[0] : null;
				const { data } = await env.AI.run('@cf/baai/bge-base-en-v1.5', { text: [chunk.pageContent] });
				const values = data[0];
				const { id } = record;
				const inserted = await env.VECTORIZE.upsert([
					{
						id: id.toString(),
						values,
						metadata: {},
					},
				]);
				message.ack();
			} catch (e) {
				console.log(e);
			}
		}
	},
};
