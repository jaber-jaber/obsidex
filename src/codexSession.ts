import type {
	AssistantMessageEvent,
	CopilotSession,
	CustomAgentConfig,
	ElicitationContext,
	ElicitationResult,
	MessageOptions,
	PermissionHandler,
	PermissionRequest,
	SessionConfig,
	SessionEvent,
	SessionEventHandler,
	SessionEventType,
	TypedSessionEventHandler,
} from '@github/copilot-sdk';
import type {UserInputRequest} from '@github/copilot-sdk/dist/types';

type RpcRequest = (method: string, params: unknown) => Promise<unknown>;
type RpcNotificationHandler = (params: unknown) => void;
type RpcServerRequestHandler = (method: string, id: string | number, params: unknown) => Promise<{handled: boolean; result?: unknown} | void> | {handled: boolean; result?: unknown} | void;

type CodexSessionDeps = {
	request: RpcRequest;
	onNotification: (method: string, handler: RpcNotificationHandler) => () => void;
	onServerRequest: (handler: RpcServerRequestHandler) => () => void;
};

type ToolLikeItem =
	| {type: 'commandExecution'; id: string; command?: string | null; cwd?: string | null; aggregatedOutput?: string | null; exitCode?: number | null; status?: string | null}
	| {type: 'mcpToolCall'; id: string; server?: string; tool?: string; result?: unknown; error?: unknown; status?: string | null}
	| {type: 'dynamicToolCall'; id: string; tool?: string; contentItems?: unknown; success?: boolean | null; status?: string | null}
	| {type: 'fileChange'; id: string; changes?: unknown; status?: string | null};

type ApprovalRequestParams = {
	threadId?: string;
	turnId?: string | null;
	itemId?: string;
	reason?: string | null;
	command?: string | null;
	cwd?: string | null;
	commandActions?: unknown;
	additionalPermissions?: unknown;
	permissions?: unknown;
	grantRoot?: string | null;
};

function makeEventId(): string {
	return `codex-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function toIsoTimestamp(value?: number | null): string {
	if (!value) return new Date().toISOString();
	return new Date(value * 1000).toISOString();
}

function isImagePath(path: string): boolean {
	return /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(path);
}

function stringifyUnknown(value: unknown): string {
	if (value == null) return '';
	if (typeof value === 'string') return value;
	try {
		return JSON.stringify(value, null, 2);
	} catch {
		return String(value);
	}
}

function mapApprovalPolicy(_config: SessionConfig): 'untrusted' {
	return 'untrusted';
}

function mapReasoningEffort(value: SessionConfig['reasoningEffort']): string | null {
	return value ? String(value) : null;
}

function buildAttachmentNotes(attachments?: MessageOptions['attachments']): {text: string; extraInputs: Array<Record<string, unknown>>} {
	if (!attachments || attachments.length === 0) {
		return {text: '', extraInputs: []};
	}

	const notes: string[] = [];
	const extraInputs: Array<Record<string, unknown>> = [];

	for (const attachment of attachments) {
		switch (attachment.type) {
			case 'file':
				if (isImagePath(attachment.path)) {
					extraInputs.push({type: 'localImage', path: attachment.path});
					notes.push(`Attached image: ${attachment.displayName ?? attachment.path}`);
				} else {
					notes.push(`Attached file: ${attachment.path}`);
				}
				break;
			case 'directory':
				notes.push(`Attached directory: ${attachment.path}`);
				break;
			case 'selection':
				notes.push(`Attached selection from ${attachment.filePath}`);
				if (attachment.text) {
					notes.push(`Selection text:\n${attachment.text}`);
				}
				break;
			case 'blob':
				notes.push(`Attached binary item "${attachment.displayName ?? 'attachment'}" could not be sent directly; describe or inspect it from local files if applicable.`);
				break;
		}
	}

	if (notes.length === 0) {
		return {text: '', extraInputs};
	}

	return {
		text: `\n\nAttached context:\n${notes.map(note => `- ${note}`).join('\n')}`,
		extraInputs,
	};
}

function buildUserInput(options: MessageOptions): Array<Record<string, unknown>> {
	const {text, extraInputs} = buildAttachmentNotes(options.attachments);
	return [
		{
			type: 'text',
			text: `${options.prompt}${text}`,
			text_elements: [],
		},
		...extraInputs,
	];
}

function formatUserContent(content: Array<Record<string, unknown>>): string {
	const parts: string[] = [];
	for (const input of content) {
		switch (input.type) {
			case 'text':
				if (typeof input.text === 'string') parts.push(input.text);
				break;
			case 'image':
				if (typeof input.url === 'string') parts.push(`[Image: ${input.url}]`);
				break;
			case 'localImage':
				if (typeof input.path === 'string') parts.push(`[Local image: ${input.path}]`);
				break;
			case 'skill':
				if (typeof input.name === 'string') parts.push(`$${input.name}`);
				break;
			case 'mention':
				if (typeof input.name === 'string') parts.push(`@${input.name}`);
				break;
		}
	}
	return parts.join('\n\n').trim();
}

function buildPermissionRequest(method: string, params: ApprovalRequestParams): PermissionRequest {
	switch (method) {
		case 'item/commandExecution/requestApproval':
		case 'execCommandApproval':
			return {
				kind: 'shell',
				toolCallId: params.itemId,
				command: params.command,
				cwd: params.cwd,
				reason: params.reason,
				commandActions: params.commandActions,
				additionalPermissions: params.additionalPermissions,
			};
		case 'item/fileChange/requestApproval':
		case 'applyPatchApproval':
			return {
				kind: 'write',
				toolCallId: params.itemId,
				reason: params.reason,
				grantRoot: params.grantRoot,
			};
		case 'item/permissions/requestApproval':
			return {
				kind: 'custom-tool',
				toolCallId: params.itemId,
				reason: params.reason,
				permissions: params.permissions,
			};
		default:
			return {
				kind: 'custom-tool',
				toolCallId: params.itemId,
				reason: params.reason,
			};
	}
}

function permissionResultToDecision(method: string, result: Awaited<ReturnType<PermissionHandler>> | undefined): unknown {
	const allow = result?.kind === 'approved';
	if (method === 'execCommandApproval' || method === 'applyPatchApproval') {
		return {decision: allow ? 'allow' : 'deny'};
	}
	return {decision: allow ? 'accept' : 'decline'};
}

export class CodexSession {
	readonly sessionId: string;
	readonly rpc: {agent: {select: ({name}: {name: string}) => Promise<void>}};

	private readonly allHandlers = new Set<SessionEventHandler>();
	private readonly typedHandlers = new Map<SessionEventType, Set<TypedSessionEventHandler<SessionEventType>>>();
	private readonly unsubscribers: Array<() => void> = [];
	private lastEventId: string | null = null;
	private disconnected = false;
	private activeTurnId: string | null = null;
	private selectedModel?: string;
	private readonly agentsByName = new Map<string, CustomAgentConfig>();

	constructor(
		sessionId: string,
		private readonly config: SessionConfig,
		private readonly deps: CodexSessionDeps,
	) {
		this.sessionId = sessionId;
		this.selectedModel = config.model ?? undefined;

		for (const agent of config.customAgents ?? []) {
			this.agentsByName.set(agent.name, agent);
		}

		this.rpc = {
			agent: {
				select: async ({name}: {name: string}) => {
					this.selectAgent(name);
				},
			},
		};

		this.unsubscribers.push(
			deps.onNotification('turn/started', params => this.handleTurnStarted(params)),
			deps.onNotification('turn/completed', params => this.handleTurnCompleted(params)),
			deps.onNotification('item/agentMessage/delta', params => this.handleAgentMessageDelta(params)),
			deps.onNotification('item/started', params => this.handleItemStarted(params)),
			deps.onNotification('item/completed', params => this.handleItemCompleted(params)),
			deps.onNotification('thread/tokenUsage/updated', params => this.handleTokenUsage(params)),
			deps.onNotification('error', params => this.handleError(params)),
			deps.onServerRequest((method, id, params) => this.handleServerRequest(method, id, params)),
		);
	}

	async send(options: MessageOptions): Promise<string> {
		this.assertConnected();
		const result = await this.deps.request('turn/start', {
			threadId: this.sessionId,
			input: buildUserInput(options),
			cwd: this.config.workingDirectory ?? null,
			approvalPolicy: mapApprovalPolicy(this.config),
			model: this.selectedModel ?? null,
			effort: mapReasoningEffort(this.config.reasoningEffort),
		});
		const turnId = (result as {turn?: {id?: string}})?.turn?.id;
		if (!turnId) {
			throw new Error('Codex turn/start did not return a turn id.');
		}
		this.activeTurnId = turnId;
		return turnId;
	}

	async sendAndWait(options: MessageOptions, timeout = 60_000): Promise<AssistantMessageEvent | undefined> {
		this.assertConnected();

		let lastAssistantMessage: AssistantMessageEvent | undefined;
		let sawTurnStart = false;

		const waitForIdle = new Promise<AssistantMessageEvent | undefined>((resolve, reject) => {
			const cleanupFns: Array<() => void> = [];
			const cleanup = () => {
				for (const fn of cleanupFns) fn();
			};

			const timer = globalThis.setTimeout(() => {
				cleanup();
				reject(new Error(`Timed out waiting for Codex turn to finish after ${timeout}ms.`));
			}, timeout);

			cleanupFns.push(() => globalThis.clearTimeout(timer));
			cleanupFns.push(this.on('assistant.turn_start', () => {
				sawTurnStart = true;
			}));
			cleanupFns.push(this.on('assistant.message', event => {
				lastAssistantMessage = event as AssistantMessageEvent;
			}));
			cleanupFns.push(this.on('session.error', event => {
				cleanup();
				reject(new Error(String(event.data.message ?? 'Codex session error')));
			}));
			cleanupFns.push(this.on('session.idle', () => {
				if (!sawTurnStart && !lastAssistantMessage) return;
				cleanup();
				resolve(lastAssistantMessage);
			}));
		});

		await this.send(options);
		return await waitForIdle;
	}

	on<K extends SessionEventType>(eventType: K, handler: TypedSessionEventHandler<K>): () => void;
	on(handler: SessionEventHandler): () => void;
	on(eventTypeOrHandler: SessionEventType | SessionEventHandler, handler?: TypedSessionEventHandler<SessionEventType>): () => void {
		if (typeof eventTypeOrHandler === 'function') {
			const callback = eventTypeOrHandler;
			this.allHandlers.add(callback);
			return () => this.allHandlers.delete(callback);
		}

		const eventType = eventTypeOrHandler;
		const set = this.typedHandlers.get(eventType) ?? new Set<TypedSessionEventHandler<SessionEventType>>();
		if (handler) set.add(handler);
		this.typedHandlers.set(eventType, set);
		return () => {
			const current = this.typedHandlers.get(eventType);
			if (!current || !handler) return;
			current.delete(handler);
			if (current.size === 0) this.typedHandlers.delete(eventType);
		};
	}

	async abort(): Promise<void> {
		this.assertConnected();
		if (!this.activeTurnId) return;
		await this.deps.request('turn/interrupt', {
			threadId: this.sessionId,
			turnId: this.activeTurnId,
		});
	}

	async disconnect(): Promise<void> {
		if (this.disconnected) return;
		this.disconnected = true;
		for (const unsubscribe of this.unsubscribers.splice(0)) {
			try {
				unsubscribe();
			} catch {
				// ignore unsubscribe failures
			}
		}
		try {
			await this.deps.request('thread/unsubscribe', {threadId: this.sessionId});
		} catch {
			// thread may already be gone or unsupported
		}
		this.allHandlers.clear();
		this.typedHandlers.clear();
	}

	async getMessages(): Promise<SessionEvent[]> {
		this.assertConnected();
		const result = await this.deps.request('thread/read', {
			threadId: this.sessionId,
			includeTurns: true,
		});
		const thread = (result as {thread?: {turns?: Array<Record<string, unknown>>}}).thread;
		const turns = Array.isArray(thread?.turns) ? thread.turns : [];
		const events: SessionEvent[] = [];

		for (const turn of turns) {
			const items = Array.isArray(turn.items) ? turn.items as Array<Record<string, unknown>> : [];
			const turnTimestamp = toIsoTimestamp(typeof turn.startedAt === 'number' ? turn.startedAt : turn.completedAt as number | null);

			for (const item of items) {
				if (item.type === 'userMessage') {
					events.push({
						id: String(item.id ?? makeEventId()),
						timestamp: turnTimestamp,
						parentId: null,
						type: 'user.message',
						data: {
							content: formatUserContent(Array.isArray(item.content) ? item.content as Array<Record<string, unknown>> : []),
						},
					} as SessionEvent);
				} else if (item.type === 'agentMessage') {
					events.push({
						id: String(item.id ?? makeEventId()),
						timestamp: turnTimestamp,
						parentId: null,
						type: 'assistant.message',
						data: {
							content: String(item.text ?? ''),
						},
					} as SessionEvent);
				}
			}
		}

		return events;
	}

	asCopilotSession(): CopilotSession {
		return this as unknown as CopilotSession;
	}

	private selectAgent(name: string): void {
		if (!this.agentsByName.has(name)) {
			throw new Error(`Unknown agent: ${name}`);
		}
	}

	private emit(type: SessionEventType, data: unknown): SessionEvent {
		const event = {
			id: makeEventId(),
			timestamp: new Date().toISOString(),
			parentId: this.lastEventId,
			type,
			data,
		} as SessionEvent;

		this.lastEventId = event.id;
		this.config.onEvent?.(event);
		for (const handler of this.allHandlers) {
			handler(event);
		}
		const typed = this.typedHandlers.get(type);
		if (typed) {
			for (const handler of typed) {
				handler(event as never);
			}
		}
		return event;
	}

	private assertConnected(): void {
		if (this.disconnected) {
			throw new Error('This Codex session has been disconnected.');
		}
	}

	private matchesThread(params: unknown): params is Record<string, unknown> {
		return Boolean(params && typeof params === 'object' && (params as {threadId?: unknown}).threadId === this.sessionId);
	}

	private handleTurnStarted(params: unknown): void {
		if (!this.matchesThread(params)) return;
		const turn = (params as {turn?: {id?: string}}).turn;
		this.activeTurnId = turn?.id ?? this.activeTurnId;
		this.emit('assistant.turn_start', {turnId: turn?.id ?? this.activeTurnId ?? makeEventId()});
	}

	private handleTurnCompleted(params: unknown): void {
		if (!this.matchesThread(params)) return;
		const turn = (params as {turn?: {id?: string; status?: string; error?: {message?: string} | null}}).turn;
		if (turn?.id && this.activeTurnId === turn.id) {
			this.activeTurnId = null;
		}
		if (turn?.status === 'failed') {
			this.emit('session.error', {
				errorType: 'codex',
				message: turn.error?.message ?? 'Codex turn failed.',
			});
		}
		this.emit('session.idle', {});
	}

	private handleAgentMessageDelta(params: unknown): void {
		if (!this.matchesThread(params)) return;
		const payload = params as {delta?: unknown; itemId?: unknown};
		const delta = payload.delta;
		if (typeof delta !== 'string' || delta.length === 0) return;
		this.emit('assistant.message_delta', {
			messageId: typeof payload.itemId === 'string' ? payload.itemId : makeEventId(),
			deltaContent: delta,
		});
	}

	private handleItemStarted(params: unknown): void {
		if (!this.matchesThread(params)) return;
		const item = (params as {item?: ToolLikeItem}).item;
		if (!item) return;

		if (item.type === 'commandExecution') {
			this.emit('tool.execution_start', {
				toolCallId: item.id,
				toolName: 'shell',
				arguments: {command: item.command, cwd: item.cwd},
			});
		} else if (item.type === 'mcpToolCall') {
			this.emit('tool.execution_start', {
				toolCallId: item.id,
				toolName: `${item.server ?? 'mcp'}:${item.tool ?? 'tool'}`,
				arguments: {},
			});
		} else if (item.type === 'dynamicToolCall') {
			this.emit('tool.execution_start', {
				toolCallId: item.id,
				toolName: item.tool ?? 'tool',
				arguments: {},
			});
		} else if (item.type === 'fileChange') {
			this.emit('tool.execution_start', {
				toolCallId: item.id,
				toolName: 'apply_patch',
				arguments: {changes: item.changes},
			});
		}
	}

	private handleItemCompleted(params: unknown): void {
		if (!this.matchesThread(params)) return;
		const item = (params as {item?: Record<string, unknown>}).item;
		if (!item) return;

		if (item.type === 'agentMessage') {
			this.emit('assistant.message', {
				messageId: typeof item.id === 'string' ? item.id : makeEventId(),
				content: String(item.text ?? ''),
			});
			return;
		}

		if (item.type === 'commandExecution') {
			const tool = item as ToolLikeItem & {type: 'commandExecution'};
			const success = tool.status === 'completed' && (tool.exitCode ?? 0) === 0;
			this.emit('tool.execution_complete', {
				toolCallId: tool.id,
				success,
				result: success ? {content: tool.aggregatedOutput ?? ''} : undefined,
				error: success ? undefined : {message: tool.aggregatedOutput ?? `Command ${tool.status ?? 'failed'}`},
			});
		} else if (item.type === 'mcpToolCall') {
			const tool = item as ToolLikeItem & {type: 'mcpToolCall'};
			const success = tool.status === 'completed' && !tool.error;
			this.emit('tool.execution_complete', {
				toolCallId: tool.id,
				success,
				result: success ? {content: stringifyUnknown(tool.result)} : undefined,
				error: success ? undefined : {message: stringifyUnknown(tool.error) || `MCP tool ${tool.status ?? 'failed'}`},
			});
		} else if (item.type === 'dynamicToolCall') {
			const tool = item as ToolLikeItem & {type: 'dynamicToolCall'};
			const success = Boolean(tool.success);
			this.emit('tool.execution_complete', {
				toolCallId: tool.id,
				success,
				result: success ? {content: stringifyUnknown(tool.contentItems)} : undefined,
				error: success ? undefined : {message: `Tool ${tool.tool ?? 'call'} failed.`},
			});
		} else if (item.type === 'fileChange') {
			const tool = item as ToolLikeItem & {type: 'fileChange'};
			const success = tool.status === 'completed';
			this.emit('tool.execution_complete', {
				toolCallId: tool.id,
				success,
				result: success ? {content: stringifyUnknown(tool.changes)} : undefined,
				error: success ? undefined : {message: `Patch ${tool.status ?? 'failed'}`},
			});
		}
	}

	private handleTokenUsage(params: unknown): void {
		if (!this.matchesThread(params)) return;
		const usage = (params as {tokenUsage?: {last?: {inputTokens?: number; outputTokens?: number; cachedInputTokens?: number}}}).tokenUsage?.last;
		if (!usage) return;
		this.emit('assistant.usage', {
			inputTokens: usage.inputTokens ?? 0,
			outputTokens: usage.outputTokens ?? 0,
			cacheReadTokens: usage.cachedInputTokens ?? 0,
			cacheWriteTokens: 0,
			model: this.selectedModel ?? 'unknown',
		});
	}

	private handleError(params: unknown): void {
		const error = (params as {error?: {message?: string}})?.error;
		if (!error?.message) return;
		this.emit('session.error', {
			errorType: 'codex',
			message: error.message,
		});
	}

	private async handleServerRequest(method: string, _id: string | number, params: unknown): Promise<{handled: boolean; result?: unknown} | void> {
		if (method === 'item/tool/requestUserInput') {
			return await this.handleUserInputRequest(params);
		}
		if (method === 'mcpServer/elicitation/request') {
			return await this.handleElicitationRequest(params);
		}
		if (
			method === 'item/commandExecution/requestApproval'
			|| method === 'item/fileChange/requestApproval'
			|| method === 'item/permissions/requestApproval'
			|| method === 'execCommandApproval'
			|| method === 'applyPatchApproval'
		) {
			return await this.handleApprovalRequest(method, params);
		}
	}

	private async handleApprovalRequest(method: string, params: unknown): Promise<{handled: boolean; result?: unknown} | void> {
		const approvalParams = (params ?? {}) as ApprovalRequestParams & {conversationId?: string};
		const requestThreadId = approvalParams.threadId ?? approvalParams.conversationId;
		if (requestThreadId !== this.sessionId) return;

		if (!this.config.onPermissionRequest) {
			return {handled: true, result: permissionResultToDecision(method, {kind: 'denied-interactively-by-user'})};
		}

		const request = buildPermissionRequest(method, approvalParams);
		const result = await this.config.onPermissionRequest(request, {sessionId: this.sessionId});
		return {handled: true, result: permissionResultToDecision(method, result)};
	}

	private async handleUserInputRequest(params: unknown): Promise<{handled: boolean; result?: unknown} | void> {
		const request = params as {threadId?: string; questions?: Array<{id: string; question: string; isOther?: boolean; options?: Array<{label: string}> | null}>};
		if (request.threadId !== this.sessionId) return;

		if (!this.config.onUserInputRequest) {
			return {handled: true, result: {answers: {}}};
		}

		const answers: Record<string, {answers: string[]}> = {};
		for (const question of request.questions ?? []) {
			const modalRequest: UserInputRequest = {
				question: question.question,
				choices: question.options?.map(option => option.label),
				allowFreeform: question.isOther !== false,
			};
			const response = await this.config.onUserInputRequest(modalRequest, {sessionId: this.sessionId});
			answers[question.id] = {
				answers: response.answer ? [response.answer] : [],
			};
		}

		return {handled: true, result: {answers}};
	}

	private async handleElicitationRequest(params: unknown): Promise<{handled: boolean; result?: unknown} | void> {
		const request = params as {
			threadId?: string;
			mode?: 'form' | 'url';
			serverName?: string;
			message?: string;
			url?: string;
			requestedSchema?: Record<string, unknown>;
			_meta?: unknown;
		};
		if (request.threadId !== this.sessionId) return;

		if (!this.config.onElicitationRequest) {
			return {handled: true, result: {action: 'cancel', content: null, _meta: request._meta ?? null}};
		}

		const context: ElicitationContext = {
			sessionId: this.sessionId,
			mode: request.mode ?? 'form',
			message: request.message ?? 'Additional input required.',
			elicitationSource: request.serverName,
			url: request.url,
			requestedSchema: request.requestedSchema as ElicitationContext['requestedSchema'],
		};
		const result = await this.config.onElicitationRequest(context);
		return {
			handled: true,
			result: this.toMcpElicitationResponse(result, request._meta),
		};
	}

	private toMcpElicitationResponse(result: ElicitationResult, meta: unknown): {action: string; content: unknown; _meta: unknown} {
		if (result.action === 'accept') {
			return {
				action: 'accept',
				content: result.content ?? null,
				_meta: meta ?? null,
			};
		}
		return {
			action: result.action,
			content: null,
			_meta: meta ?? null,
		};
	}
}
