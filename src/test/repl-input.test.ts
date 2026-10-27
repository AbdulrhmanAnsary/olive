import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';
import { LispSession } from '../session';
import { ReplView } from '../replView';

const { util } = require('swank-client');

const clientInfo = {
    children: [
        { type: 'symbol', source: 'COMMON-LISP-USER' },
        { type: 'symbol', source: 'CL-USER' }
    ]
};

function createFakeClient() {
    const handlers = new Map<string, (...args: any[]) => any>();
    const responseResolvers = new Map<string, () => void>();
    const sentMessages: string[] = [];
    let connected = true;
    const client: any = {
        on_handlers: {},
        socket: { pause() {}, resume() {} },
        on(event: string, handler: (...args: any[]) => any) {
            handlers.set(event, handler);
            this.on_handlers[event] = handler;
        },
        is_connected() {
            return connected;
        },
        send_message(message: string) {
            sentMessages.push(message);
            const match = message.match(/^\(:EMACS-RETURN-STRING \S+ (\S+) /);
            if (match) responseResolvers.get(match[1])?.();
        },
        read_string_handler() {},
        read_aborted_handler(sexp: any) {
            handlers.get('read_aborted')?.(sexp.children[2].source);
        },
        disconnect() {
            connected = false;
        },
        async rex() {
            return { type: 'symbol', source: 'T' };
        }
    };
    return {
        client,
        handlers,
        sentMessages,
        requestInput(tag: string) {
            let resolveResponse!: () => void;
            const response = new Promise<void>(resolve => resolveResponse = resolve);
            responseResolvers.set(tag, resolveResponse);
            const handler = client.read_string_handler({
                children: [{}, { source: '1' }, { source: tag }]
            });
            return { handler, response };
        }
    };
}

async function waitForMessage(
    messages: { command: string; requestId?: number }[],
    command: string,
    startIndex: number
) {
    for (let attempt = 0; attempt < 100; attempt++) {
        const message = messages.slice(startIndex).find(item => item.command === command);
        if (message) return message;
        await new Promise(resolve => setTimeout(resolve, 0));
    }
    assert.fail(`Timed out waiting for ${command} webview message`);
}

function createHarness() {
    const subscriptions: vscode.Disposable[] = [];
    const extensionPath = path.resolve(__dirname, '..', '..');
    const repl = new ReplView({
        extensionPath,
        extensionUri: vscode.Uri.file(extensionPath),
        subscriptions
    } as unknown as vscode.ExtensionContext, new Map());

    const messages: { command: string; requestId?: number }[] = [];
    let receiveMessage: (message: { command: string; text?: string; requestId?: number }) => void = () => {};
    const webview = {
        options: {},
        cspSource: 'vscode-webview:',
        asWebviewUri: (uri: vscode.Uri) => uri,
        postMessage: async (message: { command: string; requestId?: number }) => {
            messages.push(message);
            return true;
        },
        onDidReceiveMessage: (handler: typeof receiveMessage) => {
            receiveMessage = handler;
            return { dispose() {} };
        }
    };
    repl.resolveWebviewView(
        { webview } as unknown as vscode.WebviewView,
        {} as vscode.WebviewViewResolveContext,
        {} as vscode.CancellationToken
    );
    receiveMessage({ command: 'ready' });

    const fake = createFakeClient();
    repl.setClient(fake.client, clientInfo);
    const session = new LispSession({
        extensionPath,
        subscriptions
    } as unknown as vscode.ExtensionContext, repl, new Map());
    session.client = fake.client;
    session.clientReady = true;
    Object.defineProperty(session, 'reportCompilationResult', { value() {} });

    const document = {
        fileName: path.join(extensionPath, 'test.lisp'),
        isDirty: false
    } as vscode.TextDocument;
    const editor = { document } as vscode.TextEditor;

    return {
        subscriptions,
        messages,
        receiveMessage: (message: { command: string; text?: string; requestId?: number }) =>
            receiveMessage(message),
        fake,
        repl,
        session,
        editor,
        dispose() {
            session.dispose();
            for (const subscription of subscriptions.reverse()) subscription.dispose();
        }
    };
}

describe('Interactive input during file loading', () => {
    it('handles sequential reads and restores the prompt in both file-loading modes', async () => {
        const harness = createHarness();
        const { fake, messages, receiveMessage, session, editor } = harness;
        const calls: { command: string; thread: string }[] = [];
        const inputResponses: string[] = [];
        const compileResult = {
            type: 'list',
            children: [
                { type: 'symbol', source: 'NIL' },
                { type: 'symbol', source: 'NIL' },
                { type: 'symbol', source: 'T' },
                { type: 'number', source: '0.01' },
                { type: 'symbol', source: 'NIL' },
                { type: 'string', source: util.to_lisp_string('test.fasl') }
            ]
        };

        let tagNumber = 0;
        const submitRead = async (text: string) => {
            const startIndex = messages.length;
            const input = fake.requestInput(`tag-${++tagNumber}`);
            const readMessage = await waitForMessage(messages, 'read', startIndex);
            assert.ok(readMessage.requestId);
            receiveMessage({
                command: 'readSubmit',
                text,
                requestId: readMessage.requestId
            });
            await Promise.all([input.handler, input.response]);
            inputResponses.push(text);
        };

        fake.client.rex = async (command: string, _pkg: string, thread: string) => {
            calls.push({ command, thread });
            if (command.includes('COMPILE-FILE-FOR-EMACS')) return compileResult;
            await submitRead('abdo');
            await submitRead('second input');
            return { type: 'symbol', source: 'T' };
        };

        try {
            await new Promise(resolve => setTimeout(resolve, 0));
            messages.length = 0;

            await session.loadFile(editor, {} as vscode.TextEditorEdit);
            assert.deepStrictEqual(
                messages.map(message => message.command),
                ['read', 'read', 'prompt']
            );
            assert.strictEqual(calls[0].thread, 'T');

            messages.length = 0;
            await session.compileFile(editor, {} as vscode.TextEditorEdit);
            assert.deepStrictEqual(
                messages.map(message => message.command),
                ['read', 'read', 'prompt']
            );
            assert.deepStrictEqual(calls.map(call => call.thread), ['T', 'T', 'T']);
            assert.deepStrictEqual(inputResponses, [
                'abdo',
                'second input',
                'abdo',
                'second input'
            ]);
        } finally {
            harness.dispose();
        }
    });

    it('rejects overlapping file-load attempts while one is waiting for input', async () => {
        const harness = createHarness();
        const { fake, messages, receiveMessage, session, editor } = harness;
        const warnings: string[] = [];
        const originalWarning = vscode.window.showWarningMessage;
        vscode.window.showWarningMessage = ((message: string) => {
            warnings.push(message);
            return Promise.resolve(undefined);
        }) as typeof vscode.window.showWarningMessage;

        try {
            let pendingInput: ReturnType<typeof fake.requestInput> | undefined;
            fake.client.rex = async () => {
                pendingInput = fake.requestInput('concurrent-tag');
                await Promise.all([pendingInput.handler, pendingInput.response]);
                return { type: 'symbol', source: 'T' };
            };
            const firstLoad = session.loadFile(editor, {} as vscode.TextEditorEdit);
            const read = await waitForMessage(messages, 'read', 0);
            await session.loadFile(editor, {} as vscode.TextEditorEdit);
            assert.strictEqual(warnings.length, 1);
            assert.strictEqual(messages.filter(message => message.command === 'read').length, 1);
            receiveMessage({
                command: 'readSubmit',
                text: 'serialized input',
                requestId: read.requestId
            });
            await firstLoad;
        } finally {
            vscode.window.showWarningMessage = originalWarning;
            harness.dispose();
        }
    });

    it('settles an aborted read without sending a stale response', async () => {
        const harness = createHarness();
        const { fake, messages, repl } = harness;
        try {
            await new Promise(resolve => setTimeout(resolve, 0));
            messages.length = 0;
            const input = fake.requestInput('aborted-tag');
            await waitForMessage(messages, 'read', 0);
            fake.client.read_aborted_handler({
                children: [{}, { source: '1' }, { source: 'aborted-tag' }]
            });
            await input.handler;
            assert.deepStrictEqual(fake.sentMessages, []);
            assert.ok(messages.some(message => message.command === 'readCancelled'));
            repl.restorePromptAfterRead();
            await new Promise(resolve => setTimeout(resolve, 0));
            assert.strictEqual(messages.filter(message => message.command === 'prompt').length, 1);
        } finally {
            harness.dispose();
        }
    });

    it('settles a pending load on disconnect and ignores input from the old connection', async () => {
        const harness = createHarness();
        const { fake, messages, receiveMessage, repl, session, editor } = harness;
        try {
            let pendingInput: ReturnType<typeof fake.requestInput> | undefined;
            fake.client.rex = async () => {
                pendingInput = fake.requestInput('old-tag');
                return new Promise(() => {});
            };
            const loading = session.loadFile(editor, {} as vscode.TextEditorEdit);
            const oldRead = await waitForMessage(messages, 'read', 0);
            session.disconnect();
            await pendingInput?.handler;
            await loading;
            assert.deepStrictEqual(fake.sentMessages, []);
            assert.ok(messages.some(message => message.command === 'disconnect'));

            receiveMessage({
                command: 'readSubmit',
                text: 'late old input',
                requestId: oldRead.requestId
            });
            assert.deepStrictEqual(fake.sentMessages, []);

            const replacement = createFakeClient();
            repl.setClient(replacement.client, clientInfo);
            session.client = replacement.client;
            session.clientReady = true;
            const startIndex = messages.length;
            const nextInput = replacement.requestInput('new-tag');
            const newRead = await waitForMessage(messages, 'read', startIndex);
            assert.notStrictEqual(newRead.requestId, oldRead.requestId);

            receiveMessage({
                command: 'readSubmit',
                text: 'stale input',
                requestId: oldRead.requestId
            });
            await new Promise(resolve => setTimeout(resolve, 0));
            assert.deepStrictEqual(replacement.sentMessages, []);

            receiveMessage({
                command: 'readSubmit',
                text: 'fresh input',
                requestId: newRead.requestId
            });
            await Promise.all([nextInput.handler, nextInput.response]);
            assert.strictEqual(replacement.sentMessages.length, 1);
        } finally {
            harness.dispose();
        }
    });
});
