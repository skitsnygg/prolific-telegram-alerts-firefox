const extensionScope = globalThis as typeof globalThis & {
  browser?: typeof chrome;
  chrome?: typeof chrome;
};

export const webext = extensionScope.browser ?? extensionScope.chrome!;

export const runtime = webext.runtime;
export const storage = webext.storage;
export const tabs = webext.tabs;
export const notifications = webext.notifications;
export const alarms = webext.alarms;
export const action = webext.action;
export const scripting = webext.scripting;

const rawChrome = extensionScope.chrome;

type RuntimeContextFilter = Record<string, unknown>;

type OffscreenDocumentOptions = {
  url: string;
  reasons: string[];
  justification: string;
};

export function supportsOffscreenAudio(): boolean {
  return Boolean(rawChrome?.offscreen && rawChrome.runtime);
}

export async function getRuntimeContexts(
  filter: RuntimeContextFilter,
): Promise<unknown[]> {
  const getContexts = runtime.getContexts as
    | ((filter: RuntimeContextFilter) => Promise<unknown[]>)
    | undefined;

  if (!getContexts) return [];
  return await getContexts.call(runtime, filter);
}

export async function createOffscreenDocument(
  options: OffscreenDocumentOptions,
): Promise<void> {
  const createDocument = rawChrome?.offscreen?.createDocument as
    | ((options: OffscreenDocumentOptions) => Promise<void>)
    | undefined;

  if (!createDocument) {
    throw new Error("Offscreen API unavailable");
  }

  await createDocument.call(rawChrome?.offscreen, options);
}

export async function sendRuntimeMessage<T = unknown>(
  message: unknown,
): Promise<T> {
  return (await runtime.sendMessage(message as object)) as T;
}
