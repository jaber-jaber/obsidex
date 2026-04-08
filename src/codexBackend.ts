import {approveAll} from '@github/copilot-sdk';
import type {
	ConnectionState,
	GetAuthStatusResponse,
	ModelInfo,
	SessionConfig,
	SessionListFilter,
	SessionMetadata,
	MessageOptions,
	CopilotSession,
} from '@github/copilot-sdk';
import type {UserInputHandler} from '@github/copilot-sdk/dist/types';
import type {
	AssistantBackend,
	BackendPingResult,
	CodexAccountStatus,
	CodexChatGptLoginStart,
	CodexDeviceCodeLoginStart,
} from './backend/types';
import {CodexSession} from './codexSession';

const nodeRequire = typeof globalThis.require === 'function' ? globalThis.require : undefined;
declare const process: {
	env: Record<string, string | undefined>;
	platform: string;
};

type JsonRpcMessage = {
	id?: number | string;
	method?: string;
	params?: unknown;
	result?: unknown;
	error?: {code?: number; message?: string; data?: unknown};
};

type PendingRequest = {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
	method: string;
};

type ServerRequestHandler = (method: string, id: string | number, params: unknown) => Promise<{handled: boolean; result?: unknown} | void> | {handled: boolean; result?: unknown} | void;

function cleanEnv(): Record<string, string> {
	const allowedPrefixes = [
		'PATH', 'HOME', 'USERPROFILE', 'TMPDIR', 'TEMP', 'TMP',
		'LANG', 'LC_', 'SHELL', 'TERM', 'COLORTERM',
		'USER', 'USERNAME', 'LOGNAME', 'HOSTNAME',
		'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PROGRAMFILES',
		'APPDATA', 'LOCALAPPDATA', 'HOMEDRIVE', 'HOMEPATH',
		'XDG_', 'DISPLAY', 'WAYLAND_DISPLAY',
		'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY',
		'http_proxy', 'https_proxy', 'no_proxy', 'all_proxy',
		'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS',
		'CODEX_', 'OPENAI_',
	];
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value === undefined) continue;
		if (allowedPrefixes.some(prefix => key === prefix || key.startsWith(prefix))) {
			env[key] = value;
		}
	}
	return env;
}

function isWindowsShellCommand(command: string): boolean {
	return !/\.(exe|com)$/i.test(command);
}

function formatSpawnError(error: Error, codexPath: string): Error {
	const maybeCode = error as Error & {code?: string};
	if (maybeCode.code === 'ENOENT') {
		return new Error(
			`Could not find the Codex executable "${codexPath}". ` +
			`Set the full path to codex in Sidekick settings, or make sure it is available on PATH for Obsidian.`,
		);
	}
	return error;
}

export class CodexBackend implements AssistantBackend {
	private proc: import('node:child_process').ChildProcessWithoutNullStreams | null = null;
	private state: ConnectionState = 'disconnected';
	private connectPromise: Promise<void> | null = null;
	private nextRequestId = 1;
	private pending = new Map<number, PendingRequest>();
	private stdoutBuffer = '';
	private stderrBuffer = '';
	private notificationHandlers = new Map<string, Set<(params: unknown) => void>>();
	private serverRequestHandlers = new Set<ServerRequestHandler>();

	constructor(private readonly opts?: {codexPath?: string}) {}

	getState(): ConnectionState {
		return this.state;
	}

	async ensureConnected(): Promise<void> {
		if (this.state === 'connected') return;
		if (this.connectPromise) {
			await this.connectPromise;
			return;
		}
		this.connectPromise = this.connectInternal();
		try {
			await this.connectPromise;
		} finally {
			this.connectPromise = null;
		}
	}

	async getAuthStatus(): Promise<GetAuthStatusResponse> {
		const account = await this.getAccountStatus();
		return {
			isAuthenticated: Boolean(account.account),
		} as GetAuthStatusResponse;
	}

	async listModels(): Promise<ModelInfo[]> {
		await this.ensureConnected();
		const result = await this.request('model/list', {});
		const rows = ((result as {data?: Array<Record<string, unknown>>}).data ?? []);
		return rows.map((row) => {
			const supportedReasoningEfforts = Array.isArray(row['supportedReasoningEfforts'])
				? (row['supportedReasoningEfforts'] as Array<Record<string, unknown>>)
					.map((item) => item['reasoningEffort'])
					.filter((item): item is string => typeof item === 'string')
				: [];
			return {
				id: String(row['id'] ?? row['model'] ?? ''),
				name: String(row['displayName'] ?? row['model'] ?? row['id'] ?? 'Unknown model'),
				version: String(row['model'] ?? row['id'] ?? ''),
				supportedReasoningEfforts,
				capabilities: {
					supports: {
						vision: false,
						reasoningEffort: supportedReasoningEfforts.length > 0,
					},
					limits: {
						max_context_window_tokens: 0,
					},
				},
			} as ModelInfo;
		}).filter((model) => model.id.length > 0);
	}

	async createSession(config: SessionConfig): Promise<CopilotSession> {
		await this.ensureConnected();
		const session = await this.startThread(config);
		return session.asCopilotSession();
	}

	async resumeSession(sessionId: string, config: Omit<SessionConfig, 'clientName'>): Promise<CopilotSession> {
		await this.ensureConnected();
		const instructions = this.buildInstructionConfig(config);
		await this.request('thread/resume', {
			threadId: sessionId,
			model: config.model ?? null,
			cwd: config.workingDirectory ?? null,
			approvalPolicy: this.mapApprovalPolicy(config),
			persistExtendedHistory: true,
			...instructions,
		});
		return new CodexSession(sessionId, config, this.buildSessionDeps()).asCopilotSession();
	}

	async listSessions(filter?: SessionListFilter): Promise<SessionMetadata[]> {
		await this.ensureConnected();
		const result = await this.request('thread/list', {
			limit: 200,
			sortKey: 'updated_at',
			archived: false,
			...(filter?.cwd ? {cwd: filter.cwd} : {}),
		}) as {data?: Array<{
			id: string;
			createdAt: number;
			updatedAt: number;
			cwd?: string;
			gitInfo?: {root?: string; repo?: string; branch?: string} | null;
			name?: string | null;
		}>};

		return (result.data ?? []).map((thread) => ({
			sessionId: thread.id,
			startTime: new Date(thread.createdAt * 1000),
			modifiedTime: new Date(thread.updatedAt * 1000),
			summary: thread.name ?? undefined,
			isRemote: false,
			context: thread.cwd ? {
				cwd: thread.cwd,
				gitRoot: thread.gitInfo?.root,
				repository: thread.gitInfo?.repo,
				branch: thread.gitInfo?.branch,
			} : undefined,
		} as SessionMetadata));
	}

	async deleteSession(sessionId: string): Promise<void> {
		await this.ensureConnected();
		await this.request('thread/archive', {threadId: sessionId});
	}

	async getLastSessionId(): Promise<string | undefined> {
		const sessions = await this.listSessions();
		return sessions[0]?.sessionId;
	}

	async chat(options: {
		prompt: string;
		model?: string;
		systemMessage?: string;
		customAgents?: import('@github/copilot-sdk').CustomAgentConfig[];
		agent?: string;
		onPermissionRequest?: import('@github/copilot-sdk').PermissionHandler;
		onUserInputRequest?: UserInputHandler;
		onElicitationRequest?: import('@github/copilot-sdk').ElicitationHandler;
		attachments?: MessageOptions['attachments'];
	}): Promise<string | undefined> {
		const session = await this.createSession({
			model: options.model,
			agent: options.agent,
			customAgents: options.customAgents,
			onPermissionRequest: options.onPermissionRequest ?? approveAll,
			...(options.onUserInputRequest ? {onUserInputRequest: options.onUserInputRequest} : {}),
			...(options.onElicitationRequest ? {onElicitationRequest: options.onElicitationRequest} : {}),
			...(options.systemMessage ? {systemMessage: {content: options.systemMessage}} : {}),
		});
		try {
			const response = await session.sendAndWait({
				prompt: options.prompt,
				...(options.attachments ? {attachments: options.attachments} : {}),
			});
			return response?.data.content;
		} finally {
			await session.disconnect();
		}
	}

	async inlineChat(options: {
		prompt: string;
		model?: string;
		systemMessage?: string;
		customAgents?: import('@github/copilot-sdk').CustomAgentConfig[];
		agent?: string;
		onPermissionRequest?: import('@github/copilot-sdk').PermissionHandler;
		onUserInputRequest?: UserInputHandler;
		onElicitationRequest?: import('@github/copilot-sdk').ElicitationHandler;
		attachments?: MessageOptions['attachments'];
	}): Promise<{content: string | undefined; sessionId: string}> {
		const session = await this.createSession({
			model: options.model,
			agent: options.agent,
			customAgents: options.customAgents,
			onPermissionRequest: options.onPermissionRequest ?? approveAll,
			...(options.onUserInputRequest ? {onUserInputRequest: options.onUserInputRequest} : {}),
			...(options.onElicitationRequest ? {onElicitationRequest: options.onElicitationRequest} : {}),
			...(options.systemMessage ? {systemMessage: {content: options.systemMessage}} : {}),
		});
		const response = await session.sendAndWait({
			prompt: options.prompt,
			...(options.attachments ? {attachments: options.attachments} : {}),
		});
		return {content: response?.data.content, sessionId: session.sessionId};
	}

	async ping(): Promise<BackendPingResult> {
		const status = await this.getAccountStatus();
		const suffix = status.account
			? `signed in as ${status.account.email ?? status.account.type}`
			: (status.requiresOpenaiAuth ? 'not signed in' : 'auth not required');
		return {
			message: `Codex app-server connected (${suffix})`,
			timestamp: Date.now(),
		};
	}

	async getAccountStatus(): Promise<CodexAccountStatus> {
		await this.ensureConnected();
		const result = await this.request('account/read', {refreshToken: false}) as {
			account?: {type?: 'apiKey' | 'chatgpt'; email?: string; planType?: string | null} | null;
			requiresOpenaiAuth?: boolean;
		};
		return {
			account: result.account?.type
				? {
					type: result.account.type,
					...(result.account.email ? {email: result.account.email} : {}),
					...(result.account.planType !== undefined ? {planType: result.account.planType} : {}),
				}
				: null,
			requiresOpenaiAuth: Boolean(result.requiresOpenaiAuth),
		};
	}

	async startChatGptLogin(): Promise<CodexChatGptLoginStart> {
		await this.ensureConnected();
		return await this.request('account/login/start', {type: 'chatgpt'}) as CodexChatGptLoginStart;
	}

	async startDeviceCodeLogin(): Promise<CodexDeviceCodeLoginStart> {
		await this.ensureConnected();
		return await this.request('account/login/start', {type: 'chatgptDeviceCode'}) as CodexDeviceCodeLoginStart;
	}

	async logoutAccount(): Promise<void> {
		await this.ensureConnected();
		await this.request('account/logout', {});
	}

	async stop(): Promise<void> {
		for (const [, pending] of this.pending) {
			pending.reject(new Error('Codex backend stopped'));
		}
		this.pending.clear();
		this.notificationHandlers.clear();
		this.serverRequestHandlers.clear();
		this.stdoutBuffer = '';
		this.stderrBuffer = '';
		if (this.proc) {
			this.proc.removeAllListeners();
			this.proc.stdout.removeAllListeners();
			this.proc.stderr.removeAllListeners();
			this.proc.stdin.end();
			this.proc.kill();
			this.proc = null;
		}
		this.state = 'disconnected';
	}

	onNotification(method: string, handler: (params: unknown) => void): () => void {
		const handlers = this.notificationHandlers.get(method) ?? new Set<(params: unknown) => void>();
		handlers.add(handler);
		this.notificationHandlers.set(method, handlers);
		return () => {
			const existing = this.notificationHandlers.get(method);
			if (!existing) return;
			existing.delete(handler);
			if (existing.size === 0) this.notificationHandlers.delete(method);
		};
	}

	onServerRequest(handler: ServerRequestHandler): () => void {
		this.serverRequestHandlers.add(handler);
		return () => this.serverRequestHandlers.delete(handler);
	}

	private async connectInternal(): Promise<void> {
		if (this.proc) return;
		const childProcess = nodeRequire?.('node:child_process') as typeof import('node:child_process') ?? await import('node:child_process');
		const os = nodeRequire?.('node:os') as typeof import('node:os') ?? await import('node:os');
		const codexPath = (this.opts?.codexPath?.trim() || 'codex');
		const useShell = process.platform === 'win32' && isWindowsShellCommand(codexPath);
		this.state = 'connecting';
		this.proc = childProcess.spawn(codexPath, ['app-server'], {
			cwd: os.homedir(),
			env: cleanEnv(),
			stdio: ['pipe', 'pipe', 'pipe'],
			...(useShell ? {shell: true} : {}),
		});

		this.proc.stdout.setEncoding('utf8');
		this.proc.stderr.setEncoding('utf8');
		this.proc.stdout.on('data', (chunk: string) => this.handleStdoutChunk(chunk));
		this.proc.stderr.on('data', (chunk: string) => {
			this.stderrBuffer += chunk;
			const trimmed = chunk.trim();
			if (trimmed.length > 0) {
				console.debug('[sidekick][codex]', trimmed);
			}
		});
		this.proc.on('exit', (code, signal) => {
			const message = `Codex app-server exited${code != null ? ` with code ${code}` : ''}${signal ? ` (${signal})` : ''}.`;
			this.handleFatalError(new Error(message));
		});
		this.proc.on('error', (error) => {
			const normalized = error instanceof Error ? formatSpawnError(error, codexPath) : new Error(String(error));
			this.handleFatalError(normalized);
		});

		try {
			await this.request('initialize', {
				clientInfo: {
					name: 'obsidian-sidekick',
					title: 'Obsidian Sidekick',
					version: '1.2.2',
				},
				capabilities: {
					experimentalApi: true,
				},
			});
			this.notify('initialized', {});
			this.state = 'connected';
		} catch (error) {
			await this.stop();
			this.state = 'error';
			throw error;
		}
	}

	private handleStdoutChunk(chunk: string): void {
		this.stdoutBuffer += chunk;
		while (true) {
			const newlineIndex = this.stdoutBuffer.indexOf('\n');
			if (newlineIndex === -1) break;
			const line = this.stdoutBuffer.slice(0, newlineIndex).trim();
			this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
			if (line.length === 0) continue;
			try {
				this.handleMessage(JSON.parse(line) as JsonRpcMessage);
			} catch (error) {
				console.error('[sidekick][codex] Failed to parse stdout line', line, error);
			}
		}
	}

	private handleMessage(message: JsonRpcMessage): void {
		if (message.method && message.id !== undefined) {
			void this.handleServerRequest(message);
			return;
		}
		if (typeof message.id === 'number') {
			const pending = this.pending.get(message.id);
			if (!pending) return;
			this.pending.delete(message.id);
			if (message.error) {
				pending.reject(new Error(`${pending.method}: ${message.error.message ?? 'Unknown JSON-RPC error'}`));
			} else {
				pending.resolve(message.result);
			}
			return;
		}
		if (!message.method) return;
		const handlers = this.notificationHandlers.get(message.method);
		if (!handlers) return;
		for (const handler of handlers) {
			try {
				handler(message.params);
			} catch (error) {
				console.error(`[sidekick][codex] Notification handler failed for ${message.method}`, error);
			}
		}
	}

	private async handleServerRequest(message: JsonRpcMessage): Promise<void> {
		const {method, id, params} = message;
		if (!method || id === undefined) return;
		for (const handler of this.serverRequestHandlers) {
			try {
				const result = await handler(method, id, params);
				if (result?.handled) {
					this.respond(id, result.result ?? null);
					return;
				}
			} catch (error) {
				this.respond(id, null, {
					code: -32000,
					message: error instanceof Error ? error.message : String(error),
				});
				return;
			}
		}
		this.respond(id, null, {
			code: -32601,
			message: `Unsupported Codex server request: ${method}`,
		});
	}

	private async request(method: string, params: unknown): Promise<unknown> {
		await this.ensureProcessStarted();
		const id = this.nextRequestId++;
		const payload = JSON.stringify({id, method, params});
		return await new Promise<unknown>((resolve, reject) => {
			this.pending.set(id, {resolve, reject, method});
			this.proc!.stdin.write(`${payload}\n`, 'utf8', (error?: Error | null) => {
				if (error) {
					this.pending.delete(id);
					reject(error);
				}
			});
		});
	}

	private notify(method: string, params: unknown): void {
		if (!this.proc) return;
		const payload = JSON.stringify({method, params});
		this.proc.stdin.write(`${payload}\n`);
	}

	private respond(id: string | number, result?: unknown, error?: {code?: number; message?: string; data?: unknown}): void {
		if (!this.proc) return;
		const payload = error
			? {id, error}
			: {id, result};
		this.proc.stdin.write(`${JSON.stringify(payload)}\n`);
	}

	private async ensureProcessStarted(): Promise<void> {
		if (!this.proc) {
			await this.connectInternal();
		}
	}

	private handleFatalError(error: Error): void {
		this.proc = null;
		if (this.state !== 'error') {
			this.state = 'error';
		}
		for (const [, pending] of this.pending) {
			pending.reject(error);
		}
		this.pending.clear();
		this.serverRequestHandlers.clear();
	}

	private async startThread(config: SessionConfig): Promise<CodexSession> {
		const instructions = this.buildInstructionConfig(config);
		const result = await this.request('thread/start', {
			model: config.model ?? null,
			cwd: config.workingDirectory ?? null,
			approvalPolicy: this.mapApprovalPolicy(config),
			serviceName: 'obsidian-sidekick',
			experimentalRawEvents: false,
			persistExtendedHistory: true,
			...instructions,
		}) as {thread?: {id?: string}};
		const sessionId = result.thread?.id;
		if (!sessionId) {
			throw new Error('Codex thread/start did not return a thread id.');
		}
		return new CodexSession(sessionId, config, this.buildSessionDeps());
	}

	private buildSessionDeps(): ConstructorParameters<typeof CodexSession>[2] {
		return {
			request: (method, params) => this.request(method, params),
			onNotification: (method, handler) => this.onNotification(method, handler),
			onServerRequest: (handler) => this.onServerRequest(handler),
		};
	}

	private buildInstructionConfig(config: SessionConfig): {baseInstructions?: string; developerInstructions?: string} {
		let agentPrompt: string | undefined;
		if (config.agent && config.customAgents) {
			agentPrompt = config.customAgents.find(agent => agent.name === config.agent)?.prompt ?? undefined;
		}

		if (config.systemMessage && 'mode' in config.systemMessage && config.systemMessage.mode === 'replace') {
			return {
				baseInstructions: config.systemMessage.content ?? undefined,
				...(agentPrompt ? {developerInstructions: agentPrompt} : {}),
			};
		}

		const developerParts = [
			config.systemMessage && 'content' in config.systemMessage ? config.systemMessage.content : undefined,
			agentPrompt,
		].filter((value): value is string => Boolean(value && value.trim().length > 0));

		return developerParts.length > 0
			? {developerInstructions: developerParts.join('\n\n')}
			: {};
	}

	private mapApprovalPolicy(_config: SessionConfig): 'untrusted' {
		return 'untrusted';
	}
}
