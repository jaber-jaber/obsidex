import type {
	ConnectionState,
	ModelInfo,
	SessionConfig,
	SessionMetadata,
	SessionListFilter,
	GetAuthStatusResponse,
	AssistantMessageEvent,
	MessageOptions,
	CopilotSession,
} from '@github/copilot-sdk';
import type {CustomAgentConfig, PermissionHandler, ElicitationHandler} from '@github/copilot-sdk';
import type {UserInputHandler} from '@github/copilot-sdk/dist/types';

export interface BackendPingResult {
	message: string;
	timestamp: number;
}

export interface CodexAccountStatus {
	account: {
		type: 'apiKey' | 'chatgpt';
		email?: string;
		planType?: string | null;
	} | null;
	requiresOpenaiAuth: boolean;
}

export interface CodexChatGptLoginStart {
	type: 'chatgpt';
	loginId: string;
	authUrl: string;
}

export interface CodexDeviceCodeLoginStart {
	type: 'chatgptDeviceCode';
	loginId: string;
	verificationUrl: string;
	userCode: string;
}

export interface AssistantBackend {
	ensureConnected(): Promise<void>;
	getState(): ConnectionState;
	getAuthStatus(): Promise<GetAuthStatusResponse>;
	listModels(): Promise<ModelInfo[]>;
	createSession(config: SessionConfig): Promise<CopilotSession>;
	resumeSession(sessionId: string, config: Omit<SessionConfig, 'clientName'>): Promise<CopilotSession>;
	listSessions(filter?: SessionListFilter): Promise<SessionMetadata[]>;
	deleteSession(sessionId: string): Promise<void>;
	getLastSessionId(): Promise<string | undefined>;
	chat(options: {
		prompt: string;
		model?: string;
		systemMessage?: string;
		customAgents?: CustomAgentConfig[];
		agent?: string;
		onPermissionRequest?: PermissionHandler;
		onUserInputRequest?: UserInputHandler;
		onElicitationRequest?: ElicitationHandler;
		attachments?: MessageOptions['attachments'];
	}): Promise<string | undefined>;
	inlineChat(options: {
		prompt: string;
		model?: string;
		systemMessage?: string;
		customAgents?: CustomAgentConfig[];
		agent?: string;
		onPermissionRequest?: PermissionHandler;
		onUserInputRequest?: UserInputHandler;
		onElicitationRequest?: ElicitationHandler;
		attachments?: MessageOptions['attachments'];
	}): Promise<{content: string | undefined; sessionId: string}>;
	ping(): Promise<BackendPingResult>;
	stop(): Promise<void>;
	getAccountStatus?(): Promise<CodexAccountStatus>;
	startChatGptLogin?(): Promise<CodexChatGptLoginStart>;
	startDeviceCodeLogin?(): Promise<CodexDeviceCodeLoginStart>;
	logoutAccount?(): Promise<void>;
}
