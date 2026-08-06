import type {
  BrowserPageCallable,
  BrowserTransformDirectionName,
  BrowserTransformExecution,
  BrowserTransformProfile,
  BrowserTransformProfileInput,
} from '@/types/models';

export const DEFAULT_TRANSFORM_REPLAY_BODY = '{\n  "value": "plain"\n}';

export type ReplayPersistenceState =
  | 'memory'
  | 'loading'
  | 'ready'
  | 'saving'
  | 'saved'
  | 'too-large'
  | 'error';

export interface TransformWorkspaceState {
  profiles: BrowserTransformProfile[];
  callables: BrowserPageCallable[];
  selectedProfileId: string;
  draft?: BrowserTransformProfileInput;
  directionName: BrowserTransformDirectionName;
  loadError: string;
  testMethod: string;
  testUrl: string;
  testHeaders: string;
  testBody: string;
  testSample?: { body: string; label: string };
  testResult?: BrowserTransformExecution;
  testError: string;
  replayPersistence: ReplayPersistenceState;
  replayStorageError: string;
  replayLoadedKey: string;
  editorMode: 'guided' | 'advanced';
  confirmDeleteCallableId: string;
}

export const INITIAL_TRANSFORM_WORKSPACE_STATE: TransformWorkspaceState = {
  profiles: [],
  callables: [],
  selectedProfileId: '',
  directionName: 'request',
  loadError: '',
  testMethod: 'POST',
  testUrl: '',
  testHeaders: '{"Content-Type":"application/json"}',
  testBody: DEFAULT_TRANSFORM_REPLAY_BODY,
  testError: '',
  replayPersistence: 'memory',
  replayStorageError: '',
  replayLoadedKey: '',
  editorMode: 'guided',
  confirmDeleteCallableId: '',
};

export type TransformWorkspaceAction =
  | { type: 'patch'; value: Partial<TransformWorkspaceState> }
  | {
    type: 'update';
    update: (state: TransformWorkspaceState) => TransformWorkspaceState;
  }
  | {
    type: 'replay.apply';
    fields: {
      method: string;
      url: string;
      headers: string;
      body: string;
      sample?: { body: string; label: string };
    };
  }
  | {
    type: 'profile.select';
    selectedProfileId: string;
    draft?: BrowserTransformProfileInput;
    directionName: BrowserTransformDirectionName;
    editorMode: 'guided' | 'advanced';
  };

export function transformWorkspaceReducer(
  state: TransformWorkspaceState,
  action: TransformWorkspaceAction,
): TransformWorkspaceState {
  switch (action.type) {
    case 'patch': return { ...state, ...action.value };
    case 'update': return action.update(state);
    case 'replay.apply':
      return {
        ...state,
        testMethod: action.fields.method,
        testUrl: action.fields.url,
        testHeaders: action.fields.headers,
        testBody: action.fields.body,
        testSample: action.fields.sample,
        testResult: undefined,
        testError: '',
      };
    case 'profile.select':
      return {
        ...state,
        selectedProfileId: action.selectedProfileId,
        draft: action.draft,
        directionName: action.directionName,
        editorMode: action.editorMode,
        testResult: undefined,
      };
  }
}
