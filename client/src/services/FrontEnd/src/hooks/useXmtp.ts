import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAccount, useWalletClient } from "wagmi";
import {
  Client,
  type Identifier,
  type Signer as XmtpSigner,
  type ConversationContainer,
  type DecodedMessage,
  ConsentState,
} from "@xmtp/browser-sdk";

/* ---------- configuration ---------- */
const XMTP_ENV = (import.meta.env.VITE_XMTP_ENV as "production" | "dev" | "local") ?? "production";
const APP_VERSION = import.meta.env.VITE_APP_VERSION ?? "caw/0.1";

/* ---------- module-level singleton ---------- */
let sharedClient: Client | null = null;
let sharedInitPromise: Promise<Client> | null = null;

/* ---------- helpers ---------- */
function hexToBytes(hexString: string): Uint8Array {
  const clean = hexString.startsWith("0x") ? hexString.slice(2) : hexString;
  const bytes = new Uint8Array(clean.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = parseInt(clean.substr(index * 2, 2), 16);
  }
  return bytes;
}

function buildIdentifier(addressHex: `0x${string}`): Identifier {
  return { identifier: addressHex.toLowerCase(), identifierKind: "Ethereum" };
}

function looksLikeSmartAccount(walletClient: any): boolean {
  const hint = (walletClient?.account?.type || walletClient?.type || "").toString().toLowerCase();
  return hint.includes("smart");
}

function makeXmtpSigner(walletClient: any, addressHex: `0x${string}`, chainIdNumber: number): XmtpSigner {
  console.log('XMTP: Creating signer for address:', addressHex, 'chain:', chainIdNumber);

  const isSmartAccount = looksLikeSmartAccount(walletClient);
  console.log('XMTP: Account type:', isSmartAccount ? 'Smart Contract Wallet' : 'EOA');

  const base = {
    getIdentifier: () => {
      const identifier = buildIdentifier(addressHex);
      console.log('XMTP: getIdentifier called, returning:', identifier);
      return identifier;
    },
    signMessage: async (message: string) => {
      console.log('XMTP: signMessage called with message:', message.substring(0, 50) + '...');
      try {
        const signatureHex = await walletClient.signMessage({ account: addressHex, message });
        const signatureBytes = hexToBytes(signatureHex);
        console.log('XMTP: Message signed successfully, signature length:', signatureBytes.length);
        return signatureBytes;
      } catch (error) {
        console.error('XMTP: Failed to sign message:', error);
        throw error;
      }
    },
    getChainId: () => {
      const chainId = BigInt(chainIdNumber);
      console.log('XMTP: getChainId called, returning:', chainId);
      return chainId;
    },
  };

  const signer = isSmartAccount
    ? ({ type: "SCW", ...base } as XmtpSigner)
    : ({ type: "EOA", ...base } as XmtpSigner);

  console.log('XMTP: Signer created with type:', signer.type);
  return signer;
}

async function ensureClient(xmtpSigner: XmtpSigner): Promise<Client> {
  if (sharedClient) {
    console.log('XMTP: Using existing client');
    return sharedClient;
  }

  if (!sharedInitPromise) {
    console.log('XMTP: Starting client initialization with config:', {
      env: XMTP_ENV,
      appVersion: APP_VERSION,
      signerType: xmtpSigner.type,
    });

    sharedInitPromise = Client.create(xmtpSigner, {
      env: XMTP_ENV,
      appVersion: APP_VERSION,
    })
    .then((client) => {
      console.log('XMTP: Client created successfully!', client);
      sharedClient = client;
      return client;
    })
    .catch((error) => {
      console.error('XMTP: Client creation failed:', error);
      console.error('XMTP: Error details:', {
        message: error.message,
        stack: error.stack,
        name: error.name
      });
      sharedInitPromise = null; // Reset so it can be retried
      throw error;
    });
  }

  console.log('XMTP: Waiting for existing initialization promise...');
  return sharedInitPromise;
}

/* ---------- core (shared by the three hooks) ---------- */
function useXmtpCore() {
  const { address, isConnected, chain } = useAccount();
  const { data: walletClient } = useWalletClient();

  const xmtpSigner = useMemo(() => {
    if (!walletClient || !address || !chain?.id) return null;
    return makeXmtpSigner(walletClient, address as `0x${string}`, Number(chain.id));
  }, [walletClient, address, chain?.id]);

  const [xmtpClient, setXmtpClient] = useState<Client | null>(sharedClient);
  const [isInitialized, setIsInitialized] = useState<boolean>(Boolean(sharedClient));
  const [isLoading, setIsLoading] = useState(false);
  const [initError, setInitError] = useState<Error | null>(null);

  const initializeClient = useCallback(async () => {
    if (!isConnected || !xmtpSigner) {
      const error = new Error("Wallet not connected or signer unavailable");
      setInitError(error);
      throw error;
    }
    setIsLoading(true);
    setInitError(null);
    try {
      const client = await ensureClient(xmtpSigner);
      setXmtpClient(client);
      setIsInitialized(true);
    } catch (error) {
      setXmtpClient(null);
      setIsInitialized(false);
      setInitError(error as Error);
      throw error;
    } finally {
      setIsLoading(false);
    }
  }, [isConnected, xmtpSigner]);

  return { xmtpClient, isInitialized, isLoading, error: initError, initializeClient };
}

/* ---------- exported hooks expected by your Messages.tsx ---------- */

export function useXmtpClient() {
  const core = useXmtpCore();

  type UiConversation = {
    id: string;
    type: "DM" | "GROUP";
    participants: Array<any>;
    name?: string;
    lastMessageAt?: string;
    unreadCount?: number;
  };

  const [conversations, setConversations] = useState<UiConversation[]>([]);
  const [messagesByConversationId, setMessagesByConversationId] = useState<
    Map<string, DecodedMessage[]>
  >(new Map());

  useEffect(() => {
    if (!core.isInitialized || !core.xmtpClient) return;
    let cancelled = false;

    (async () => {
      // Initial list
      const listed: ConversationContainer[] = await core.xmtpClient.conversations.list();
      if (!cancelled) {
        setConversations(
          listed.map((c) => ({
            id: c.id,
            type: "DM",
            participants: [],
            lastMessageAt: undefined,
            unreadCount: 0,
          }))
        );
      }

      // Stream new conversations
      const stream = await core.xmtpClient.conversations.stream({
        onValue: (container) => {
          setConversations((prev) => {
            const exists = prev.some((c) => c.id === container.id);
            return exists
              ? prev
              : [...prev, { id: container.id, type: "DM", participants: [], unreadCount: 0 }];
          });
        },
        onError: (err) => console.error("XMTP conversation stream error:", err),
      });

      (async () => {
        for await (const _ of stream) {
          if (cancelled) break;
        }
      })();
    })();

    return () => {
      cancelled = true;
    };
  }, [core.isInitialized, core.xmtpClient]);

  return {
    isInitialized: core.isInitialized,
    isLoading: core.isLoading,
    error: core.error,
    initializeClient: core.initializeClient,
    conversations,
    messages: messagesByConversationId,
    setMessages: setMessagesByConversationId,
  };
}

export function useConversations() {
  const { xmtpClient, isInitialized } = useXmtpCore();
  const [isLoading, setIsLoading] = useState(false);

  const startConversation = useCallback(
    async (peerAddress: string) => {
      if (!isInitialized || !xmtpClient) throw new Error("XMTP not initialized");

      const reachability = await Client.canMessage([
        { identifier: peerAddress, identifierKind: "Ethereum" } as Identifier,
      ]);
      if (!reachability.get(peerAddress)) throw new Error("Peer cannot receive XMTP messages");

      const peerInboxId = await xmtpClient.inbox.getInboxId({
        identifier: peerAddress,
        identifierKind: "Ethereum",
      });
      const dm = await xmtpClient.conversations.newDm(peerInboxId);

      return {
        id: dm.id,
        type: "DM" as const,
        participants: [],
        lastMessageAt: new Date().toISOString(),
        unreadCount: 0,
      };
    },
    [isInitialized, xmtpClient]
  );

  const canMessage = useCallback(async (peerAddress: string) => {
    try {
      const result = await Client.canMessage([
        { identifier: peerAddress, identifierKind: "Ethereum" } as Identifier,
      ]);
      return !!result.get(peerAddress);
    } catch {
      return false;
    }
  }, []);

  return { isLoading, startConversation, canMessage };
}

export function useMessages(conversationId: string, _optionalUserId?: number) {
  const { xmtpClient, isInitialized } = useXmtpCore();
  const [isLoading, setIsLoading] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [messages, setMessages] = useState<DecodedMessage[]>([]);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!isInitialized || !xmtpClient || !conversationId) return;

    let cancelled = false;
    const controller = new AbortController();
    abortRef.current = controller;

    (async () => {
      setIsLoading(true);
      try {
        const convo = await xmtpClient.conversations.getConversationById(conversationId);
        if (!convo) return;

        const history = await convo.listMessages();
        if (!cancelled) setMessages(history);

        const stream = await xmtpClient.conversations.streamAllMessages({
          consentStates: [ConsentState.Allowed],
          onValue: (msg) => {
            if (msg.conversationId !== conversationId) return;
            setMessages((prev) => (prev.some((m) => m.id === msg.id) ? prev : [...prev, msg]));
          },
          onError: (err) => console.error("XMTP message stream error:", err),
          signal: controller.signal,
        });

        (async () => {
          for await (const _ of stream) {
            if (cancelled) break;
          }
        })();
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();

    return () => {
      cancelled = true;
      try {
        abortRef.current?.abort();
      } catch {}
    };
  }, [isInitialized, xmtpClient, conversationId]);

  const sendMessage = useCallback(
    async (payload: { content: string; contentType?: string }) => {
      if (!isInitialized || !xmtpClient || !conversationId) return;
      setIsSending(true);
      try {
        const convo = await xmtpClient.conversations.getConversationById(conversationId);
        if (!convo) throw new Error("Conversation not found");
        const sent = await convo.sendText(payload.content);
        setMessages((prev) => [...prev, sent]); // optimistic; stream confirms
      } finally {
        setIsSending(false);
      }
    },
    [isInitialized, xmtpClient, conversationId]
  );

  const markAsRead = useCallback(() => {}, []);

  return { messages, isLoading, isSending, sendMessage, markAsRead };
}

