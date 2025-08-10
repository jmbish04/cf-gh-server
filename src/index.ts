/**
 * Welcome to Cloudflare Workers! This is your first worker.
 *
 * - Run `npm run dev` in your terminal to start a development server
 * - Open a browser tab at http://localhost:8787/ to see your worker in action
 * - Run `npm run deploy` to publish your worker
 *
 * Learn more at https://developers.cloudflare.com/workers/
 */

import { Octokit } from 'octokit';
import { applyPatch } from 'diff';
import { RepoConfig, CodeSuggestion } from './types';

export interface Env {
	GITHUB_OWNER: string;
	GITHUB_TOKEN: string;
	WEBHOOK_SECRET: string;
	WORKER_URL: string;
	BOT_EMAIL?: string;
	BOT_USERNAME?: string;
}

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const { pathname } = new URL(request.url);
		if (pathname !== '/webhook') {
			return new Response('Not Found', { status: 404 });
		}

		if (request.method !== 'POST') {
			return new Response('Expected POST', { status: 405 });
		}

		const signature = request.headers.get('X-Hub-Signature-256');
		const event = request.headers.get('X-GitHub-Event');
		const id = request.headers.get('X-GitHub-Delivery');

		if (!signature || !event || !id) {
			return new Response('Missing GitHub headers', { status: 400 });
		}

		const payloadBody = await request.clone().text();

		const isValid = await this.verifySignature(env.WEBHOOK_SECRET, signature, payloadBody);
		if (!isValid) {
			console.error('Invalid webhook signature');
			return new Response('Invalid signature', { status: 401 });
		}

		const payload = await request.json<any>();

		console.log(`Received GitHub event: "${event}" for repository: ${payload.repository?.full_name}`);

		if (!payload.repository) {
			return new Response('No repository information in payload', { status: 400 });
		}

		const octokit = new Octokit({ auth: env.GITHUB_TOKEN });
		const owner = payload.repository.owner.login;
		const repo = payload.repository.name;

		const repoConfig = await this.getRepoConfig(octokit, owner, repo);

		if (!repoConfig) {
			console.log(`[${owner}/${repo}] No config file found. Ignoring event.`);
			return new Response('Configuration not found, ignoring event.', { status: 200 });
		}

		if (!repoConfig.automatic_pr_processing) {
			console.log(`[${owner}/${repo}] Automatic processing is disabled. Ignoring event.`);
			return new Response('Automatic processing disabled.', { status: 200 });
		}

		ctx.waitUntil(this.handleEvent(event, payload, octokit, repoConfig, env));

		return new Response('Webhook event received and is being processed.', { status: 202 });
	},

	async handleEvent(event: string, payload: any, octokit: Octokit, config: RepoConfig, env: Env) {
		const repo = payload.repository;
		let prNumber: number | undefined;

		switch (event) {
			case 'issue_comment':
				if (payload.action === 'created' && payload.issue?.pull_request) {
					prNumber = payload.issue.number;
					console.log(`Processing comment on PR #${prNumber} in ${repo.full_name}`);
				}
				break;
			case 'pull_request':
				if (payload.action === 'opened' || payload.action === 'synchronize') {
					prNumber = payload.pull_request.number;
					console.log(`Processing ${payload.action} event for PR #${prNumber} in ${repo.full_name}`);
				}
				break;
			default:
				console.log(`Ignoring event: ${event}`);
				return;
		}

		if (prNumber !== undefined) {
			await this.processPullRequest(repo, prNumber, octokit, config, env);
		}
	},

	async processPullRequest(repo: any, prNumber: number, octokit: Octokit, config: RepoConfig, env: Env) {
		const owner = repo.owner.login;
		const repoName = repo.name;

		try {
			const { data: pr } = await octokit.rest.pulls.get({
				owner,
				repo: repoName,
				pull_number: prNumber,
			});

			if (pr.draft || pr.state !== 'open') {
				console.log(`[${repo.full_name}] PR #${prNumber} is a draft or not open. Skipping.`);
				return;
			}

			const { data: comments } = await octokit.rest.issues.listComments({
				owner,
				repo: repoName,
				issue_number: prNumber,
			});

			const botUsername = config.bot_username || 'gemini-code-assist[bot]';
			const botComments = comments.filter(comment => comment.user?.login === botUsername);
			console.log(`[${repo.full_name}] Found ${botComments.length} comments from bot '${botUsername}' on PR #${prNumber}.`);

			for (const comment of botComments) {
				if (!comment.body) continue;
				const suggestions = this.parseSuggestionsFromComment(comment.body);
				if (suggestions.length > 0) {
					console.log(`[${repo.full_name}] Parsed ${suggestions.length} suggestions from comment ${comment.id}.`);
					await this.applySuggestions(repo, pr, suggestions, octokit, config, env);
				}
			}
		} catch (error) {
			console.error(`[${repo.full_name}] Error processing PR #${prNumber}:`, error);
		}
	},

	async applySuggestions(repo: any, pr: any, suggestions: CodeSuggestion[], octokit: Octokit, config: RepoConfig, env: Env) {
		const owner = repo.owner.login;
		const repoName = repo.name;
		const headSha = pr.head.sha;

		console.log(`[${repo.full_name}] Attempting to apply ${suggestions.length} suggestions to branch ${pr.head.ref}`);

		const changeSet = new Map<string, string>(); // filePath -> newContent

		for (const suggestion of suggestions) {
			try {
				// Get the current content of the file
				const { data: file } = await octokit.rest.repos.getContent({
					owner,
					repo: repoName,
					path: suggestion.filePath,
					ref: headSha,
				});

				if (!('content' in file)) {
					console.error(`[${repo.full_name}] Could not get content for file ${suggestion.filePath}`);
					continue;
				}

				const originalContent = atob(file.content);

				// The patch needs the file headers.
				const patch = `--- a/${suggestion.filePath}\n+++ b/${suggestion.filePath}\n${suggestion.diff}`;

				const newContent = applyPatch(originalContent, patch);

				if (newContent === false) {
					console.error(`[${repo.full_name}] Failed to apply patch for ${suggestion.filePath}. Skipping suggestion.`);
					// If one patch fails, we might want to stop processing this whole comment.
					// For now, we'll just skip this suggestion.
					return;
				}

				changeSet.set(suggestion.filePath, newContent);
				console.log(`[${repo.full_name}] Successfully applied patch for ${suggestion.filePath}.`);

			} catch (error) {
				console.error(`[${repo.full_name}] Error applying suggestion for ${suggestion.filePath}:`, error);
				// If we fail to get a file or apply a patch, we should probably stop.
				return;
			}
		}

		if (changeSet.size === 0) {
			console.log(`[${repo.full_name}] No suggestions were successfully applied. No commit will be created.`);
			return;
		}

		// Create a commit with all the changes
		try {
			// 1. Get the base tree from the latest commit
			const { data: latestCommit } = await octokit.rest.git.getCommit({
				owner,
				repo: repoName,
				commit_sha: headSha,
			});
			const baseTreeSha = latestCommit.tree.sha;

			// 2. Create a blob for each changed file
			const blobs = await Promise.all(
				Array.from(changeSet.entries()).map(([filePath, content]) =>
					octokit.rest.git.createBlob({
						owner,
						repo: repoName,
						content,
						encoding: 'utf-8',
					}).then(response => ({
						path: filePath,
						sha: response.data.sha,
						mode: '100644' as const,
						type: 'blob' as const,
					}))
				)
			);

			// 3. Create a new tree with the new blobs
			const { data: newTree } = await octokit.rest.git.createTree({
				owner,
				repo: repoName,
				base_tree: baseTreeSha,
				tree: blobs,
			});

			// 4. Create a new commit pointing to the new tree
			const botEmail = env.BOT_EMAIL || 'bot@example.com';
			const { data: newCommit } = await octokit.rest.git.createCommit({
				owner,
				repo: repoName,
				message: `feat: Apply code suggestions for PR #${pr.number}`,
				tree: newTree.sha,
				parents: [headSha],
				author: {
					name: 'GH-Worker-Bot',
					email: botEmail,
				},
			});

			// 5. Update the branch reference to point to the new commit
			await octokit.rest.git.updateRef({
				owner,
				repo: repoName,
				ref: `heads/${pr.head.ref}`,
				sha: newCommit.sha,
			});

			console.log(`[${repo.full_name}] Successfully created commit ${newCommit.sha} on branch ${pr.head.ref}`);

			// Poll for PR status until mergeable or timeout
			await this.waitForPullRequestReady(repo, pr.number, octokit, newCommit.sha);
			await this.mergePullRequest(repo, pr.number, octokit, config);

		} catch (error) {
			console.error(`[${repo.full_name}] Error creating commit:`, error);
		}
	},

	async waitForPullRequestReady(repo: any, prNumber: number, octokit: Octokit, expectedSha: string): Promise<void> {
		const owner = repo.owner.login;
		const repoName = repo.name;
		const maxAttempts = 12; // Max 1 minute (5 second intervals)
		
		for (let attempt = 1; attempt <= maxAttempts; attempt++) {
			try {
				const { data: pr } = await octokit.rest.pulls.get({
					owner,
					repo: repoName,
					pull_number: prNumber,
				});

				// Check if the head SHA has been updated to our new commit
				if (pr.head.sha === expectedSha && pr.mergeable !== null) {
					console.log(`[${repo.full_name}] PR #${prNumber} is ready for merge (attempt ${attempt})`);
					return;
				}

				if (attempt < maxAttempts) {
					console.log(`[${repo.full_name}] PR #${prNumber} not ready yet, waiting... (attempt ${attempt}/${maxAttempts})`);
					await new Promise(resolve => setTimeout(resolve, 5000)); // Wait 5 seconds
				}
			} catch (error) {
				console.error(`[${repo.full_name}] Error checking PR status (attempt ${attempt}):`, error);
				if (attempt < maxAttempts) {
					await new Promise(resolve => setTimeout(resolve, 5000));
				}
			}
		}
		
		console.warn(`[${repo.full_name}] PR #${prNumber} still not ready after ${maxAttempts} attempts, proceeding anyway`);
	},

	async mergePullRequest(repo: any, prNumber: number, octokit: Octokit, config: RepoConfig) {
		const owner = repo.owner.login;
		const repoName = repo.name;

		console.log(`[${repo.full_name}] Attempting to merge PR #${prNumber}`);

		try {
			// Fetch the latest PR data to check mergeability
			const { data: pr } = await octokit.rest.pulls.get({
				owner,
				repo: repoName,
				pull_number: prNumber,
			});

			if (pr.merged) {
				console.log(`[${repo.full_name}] PR #${prNumber} is already merged.`);
				return;
			}

			if (pr.mergeable !== true) {
				console.error(`[${repo.full_name}] PR #${prNumber} is not mergeable or its status is unknown. State: ${pr.mergeable}`);
				// Future enhancement: Post a comment on the PR about the conflict.
				return;
			}

			// Merge the pull request
			const { data: mergeResult } = await octokit.rest.pulls.merge({
				owner,
				repo: repoName,
				pull_number: prNumber,
				merge_method: 'squash',
			});

			if (!mergeResult.merged) {
				console.error(`[${repo.full_name}] Failed to merge PR #${prNumber}. Reason: ${mergeResult.message}`);
				return;
			}

			console.log(`[${repo.full_name}] Successfully merged PR #${prNumber}.`);

			// Now, integrate into the primary branch if necessary
			const targetBranch = pr.base.ref;
			const primaryBranch = config.primary_branch || 'main';
			
			if (targetBranch !== primaryBranch) {
				console.log(`[${repo.full_name}] Integrating changes from '${targetBranch}' into '${primaryBranch}'.`);
				try {
					await octokit.rest.repos.merge({
						owner,
						repo: repoName,
						base: primaryBranch,
						head: targetBranch,
						commit_message: `Merge branch '${targetBranch}' into ${primaryBranch}`,
					});
					console.log(`[${repo.full_name}] Successfully merged '${targetBranch}' into '${primaryBranch}'.`);
				} catch (integrationError: any) {
					console.error(`[${repo.full_name}] Failed to merge '${targetBranch}' into '${primaryBranch}':`, integrationError.message);
					// Future enhancement: Notify someone about this failure.
				}
			}
		} catch (error: any) {
			console.error(`[${repo.full_name}] Error merging PR #${prNumber}:`, error.message);
		}
	},

	parseSuggestionsFromComment(commentBody: string): CodeSuggestion[] {
		const suggestions: CodeSuggestion[] = [];
		// This regex looks for a diff block for a specific file.
		const codeBlockRegex = /```diff\n--- a\/(.+?)\n\+\+\+ b\/.+?\n([\s\S]+?)```/g;

		let match;
		while ((match = codeBlockRegex.exec(commentBody)) !== null) {
			const filePath = match[1].trim();
			const diff = match[2].trim();
			if (filePath && diff) {
				suggestions.push({ filePath, diff });
			}
		}

		return suggestions;
	},

	async getRepoConfig(octokit: Octokit, owner: string, repo: string): Promise<RepoConfig | null> {
		const configPath = '.github/worker-settings.json';
		try {
			const { data } = await octokit.rest.repos.getContent({
				owner,
				repo,
				path: configPath,
			});

			if ('content' in data) {
				const content = atob(data.content);
				return JSON.parse(content) as RepoConfig;
			}
			return null;
		} catch (error: any) {
			if (error.status === 404) {
				console.log(`[${owner}/${repo}] Config file not found.`);
			} else {
				console.error(`[${owner}/${repo}] Error fetching config file:`, error);
			}
			return null;
		}
	},

	async verifySignature(secret: string, signature: string, payload: string): Promise<boolean> {
		const encoder = new TextEncoder();
		const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);

		const sigHex = signature.split('=')[1];
		const sigBytes = new Uint8Array(sigHex.match(/../g)!.map(h => parseInt(h, 16)));
		const dataBytes = encoder.encode(payload);

		return await crypto.subtle.verify('HMAC', key, sigBytes, dataBytes);
	},

	async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
		console.log('Cron job running: Checking repositories for webhooks and configuration...');

		const octokit = new Octokit({ auth: env.GITHUB_TOKEN });
		const owner = env.GITHUB_OWNER;

		try {
			// Detect if owner is a user or organization
			const { data: ownerData } = await octokit.rest.users.getByUsername({ username: owner });

			const repos = ownerData.type === 'Organization'
				? await octokit.paginate(octokit.rest.repos.listForOrg, { org: owner })
				: await octokit.paginate(octokit.rest.repos.listForUser, {
					username: owner,
					type: 'owner',
				});

			for (const repo of repos) {
				console.log(`Processing repository: ${repo.full_name}`);
				await this.ensureWebhook(octokit, owner, repo.name, env);
				await this.ensureConfigFile(octokit, owner, repo.name, env);
			}
		} catch (error) {
			console.error('Error fetching repositories:', error);
		}
	},

	async ensureWebhook(octokit: Octokit, owner: string, repo: string, env: Env): Promise<void> {
		const webhookUrl = `${env.WORKER_URL}/webhook`;
		try {
			const { data: webhooks } = await octokit.rest.repos.listWebhooks({ owner, repo });

			const managedWebhook = webhooks.find(webhook => webhook.config.url === webhookUrl);

			if (managedWebhook) {
				console.log(`[${owner}/${repo}] Found existing managed webhook.`);
				return;
			}

			console.log(`[${owner}/${repo}] No managed webhook found. Creating one...`);
			await octokit.rest.repos.createWebhook({
				owner,
				repo,
				name: 'web',
				active: true,
				events: ['pull_request', 'issue_comment'],
				config: {
					url: webhookUrl,
					content_type: 'json',
					secret: env.WEBHOOK_SECRET,
				},
			});
			console.log(`[${owner}/${repo}] Successfully created webhook.`);
		} catch (error) {
			console.error(`[${owner}/${repo}] Error ensuring webhook:`, error);
		}
	},

	async ensureConfigFile(octokit: Octokit, owner: string, repo: string, env: Env): Promise<void> {
		const configPath = '.github/worker-settings.json';

		try {
			// Check if the config file already exists
			await octokit.rest.repos.getContent({
				owner,
				repo,
				path: configPath,
			});
			console.log(`[${owner}/${repo}] Config file already exists.`);
		} catch (error: any) {
			// If error is not 404, it's an unexpected error
			if (error.status !== 404) {
				console.error(`[${owner}/${repo}] Error checking for config file:`, error);
				return;
			}

			// Error is 404, so file doesn't exist. Let's create it.
			console.log(`[${owner}/${repo}] Config file not found. Creating it...`);
			try {
				const defaultConfig: RepoConfig = {
					automatic_pr_processing: false,
					// ai_model and custom_prompts are optional and will be omitted by default
				};

				const botEmail = env.BOT_EMAIL || 'bot@example.com';
				await octokit.rest.repos.createOrUpdateFileContents({
					owner,
					repo,
					path: configPath,
					message: 'feat: Add worker configuration file',
					content: btoa(JSON.stringify(defaultConfig, null, 2)),
					committer: {
						name: 'GH-Worker-Bot',
						email: botEmail,
					},
					author: {
						name: 'GH-Worker-Bot',
						email: botEmail,
					},
				});
				console.log(`[${owner}/${repo}] Successfully created config file.`);
			} catch (creationError) {
				console.error(`[${owner}/${repo}] Error creating config file:`, creationError);
			}
		}
	},
};
