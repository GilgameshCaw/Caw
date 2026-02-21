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

/* ---------- module-level storage by address ---------- */
// Store clients by wallet address to support multiple addresses in same browser
const clientsByAddress = new Map<string, Client>();
const initPromisesByAddress = new Map<string, Promise<Client>>();

// Track the current active address to clean up old clients
let currentActiveAddress: string | null = null;

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
      console.log('XMTP: Requesting signature from wallet...');
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

async function ensureClient(xmtpSigner: XmtpSigner, walletAddress: string): Promise<Client> {
  // Normalize address to lowercase for consistent key
  const addressKey = walletAddress.toLowerCase();

  // Check if client already exists for this address
  const existingClient = clientsByAddress.get(addressKey);
  if (existingClient) {
    console.log('XMTP: Using existing client for address:', addressKey);
    return existingClient;
  }

  // Check if initialization is already in progress for this address
  const existingPromise = initPromisesByAddress.get(addressKey);
  if (existingPromise) {
    console.log('XMTP: Waiting for existing initialization promise for address:', addressKey);
    return existingPromise;
  }

  // Start new initialization for this address
  console.log('XMTP: Starting client initialization for address:', addressKey, {
    env: XMTP_ENV,
    appVersion: APP_VERSION,
    signerType: xmtpSigner.type,
  });

  console.log('XMTP: Calling Client.create() with signer...');
  const initPromise = Client.create(xmtpSigner, {
    env: XMTP_ENV,
    appVersion: APP_VERSION,
  })
  .then((client) => {
    console.log('XMTP: Client created successfully for address:', addressKey);
    clientsByAddress.set(addressKey, client);
    return client;
  })
  .catch((error) => {
    console.error('XMTP: Client creation failed for address:', addressKey, error);
    console.error('XMTP: Error details:', {
      message: error.message,
      stack: error.stack,
      name: error.name
    });
    // Remove failed promise so it can be retried
    initPromisesByAddress.delete(addressKey);
    throw error;
  });

  // Store the promise
  initPromisesByAddress.set(addressKey, initPromise);

  return initPromise;
}

/* ---------- core (shared by the three hooks) ---------- */
function useXmtpCore(hasValidUser: boolean = false, currentUserTokenId?: number) {
  const { address, isConnected, chain } = useAccount();
  const { data: walletClient } = useWalletClient();

  const xmtpSigner = useMemo(() => {
    if (!walletClient || !address || !chain?.id) return null;
    return makeXmtpSigner(walletClient, address as `0x${string}`, Number(chain.id));
  }, [walletClient, address, chain?.id]);

  const [xmtpClient, setXmtpClient] = useState<Client | null>(null);
  const [isInitialized, setIsInitialized] = useState<boolean>(false);
  const [isLoading, setIsLoading] = useState(false);
  const [isChecking, setIsChecking] = useState(false);
  const [initError, setInitError] = useState<Error | null>(null);

  // Sync with address changes - load existing client for current address
  useEffect(() => {
    const checkForClient = async () => {
      if (!address) {
        // No address - reset state completely
        console.log('XMTP: Resetting state - no wallet connected');
        currentActiveAddress = null;
        setXmtpClient(null);
        setIsInitialized(false);
        setIsChecking(false);
        return;
      }

      if (!xmtpSigner) {
        console.log('XMTP: No signer available yet');
        setIsChecking(false);
        return;
      }

      // Set checking to true immediately when starting to check for client
      setIsChecking(true);

      // Check if we already have a client for this specific address
      const addressKey = address.toLowerCase();

      // If switching to a different address, clear old clients to prevent background worker errors
      if (currentActiveAddress && currentActiveAddress !== addressKey) {
        console.log('XMTP: Switching from', currentActiveAddress, 'to', addressKey, '- clearing old clients');
        // Clear all clients except the current one (in case it was already created)
        for (const [key, client] of clientsByAddress.entries()) {
          if (key !== addressKey) {
            console.log('XMTP: Removing client for address:', key);
            clientsByAddress.delete(key);
            initPromisesByAddress.delete(key);
          }
        }
      }
      currentActiveAddress = addressKey;

      const existingClient = clientsByAddress.get(addressKey);

      if (existingClient) {
        // Found existing client for this address
        console.log('XMTP: Loading existing client from memory for address:', addressKey);
        setXmtpClient(existingClient);
        setIsInitialized(true);
        setIsChecking(false);
        return;
      }

      // No existing client for this address - try to restore from OPFS
      // Even if hasValidUser is false, we should try to restore the client
      // because the user might have initialized XMTP before logging into their CAW token
      try {
        console.log('XMTP: Attempting to restore client from OPFS for address:', addressKey, 'hasValidUser:', hasValidUser);
        const client = await ensureClient(xmtpSigner, address);
        console.log('XMTP: Client restored/created from OPFS successfully');
        setXmtpClient(client);
        setIsInitialized(true);

        // Auto-register in database if keys exist in OPFS but not in DB
        // Check by userId, not address, to allow multiple users from same wallet
        if (currentUserTokenId && address) {
          try {
            console.log('XMTP: Checking if database entry exists for userId:', currentUserTokenId);
            const checkResponse = await fetch(`${import.meta.env.VITE_API_HOST || 'http://localhost:4000'}/api/xmtp-identity/check-user/${currentUserTokenId}`);
            const checkData = await checkResponse.json();

            if (!checkData.hasXmtp) {
              // Database entry doesn't exist for this user, create it
              console.log('XMTP: No database entry found for userId', currentUserTokenId, ', auto-registering identity...');
              const registerResponse = await fetch(`${import.meta.env.VITE_API_HOST || 'http://localhost:4000'}/api/xmtp-identity/register`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  userId: currentUserTokenId,
                  walletAddress: address.toLowerCase(),
                  inboxId: client.inboxId,
                  installationId: client.installationId,
                  accountAddresses: client.accountAddresses
                })
              });

              if (registerResponse.ok) {
                console.log('XMTP: Identity auto-registered successfully for userId:', currentUserTokenId);
              } else {
                const error = await registerResponse.json();
                console.error('XMTP: Failed to auto-register identity:', error);
              }
            } else {
              console.log('XMTP: Database entry already exists for userId:', currentUserTokenId);
            }
          } catch (error) {
            console.error('XMTP: Error during auto-registration check:', error);
            // Non-fatal - client still works even if DB registration fails
          }
        }
      } catch (error) {
        console.log('XMTP: Could not restore client, user needs to initialize:', error);
        setXmtpClient(null);
        setIsInitialized(false);
      } finally {
        setIsChecking(false);
      }
    };

    checkForClient();

    // Listen for client initialization events
    const handleClientInitialized = (event: Event) => {
      const customEvent = event as CustomEvent<{ address: string }>;
      if (address && customEvent.detail.address === address.toLowerCase()) {
        console.log('XMTP: Client initialized event received, reloading client');
        checkForClient();
      }
    };

    window.addEventListener('xmtp-client-initialized', handleClientInitialized);

    return () => {
      window.removeEventListener('xmtp-client-initialized', handleClientInitialized);
    };
  }, [address, xmtpSigner, hasValidUser]);

  const initializeClient = useCallback(async () => {
    if (!isConnected || !xmtpSigner || !address) {
      const error = new Error("Wallet not connected or signer unavailable");
      setInitError(error);
      throw error;
    }

    // Check if client already exists for this address (auto-restored from OPFS)
    const addressKey = address.toLowerCase();
    const existingClient = clientsByAddress.get(addressKey);
    if (existingClient) {
      console.log('XMTP: Client already exists in memory, using it');
      setXmtpClient(existingClient);
      setIsInitialized(true);
      return;
    }

    setIsLoading(true);
    setInitError(null);
    try {
      const client = await ensureClient(xmtpSigner, address);
      console.log('XMTP: Setting client state after initialization');
      setXmtpClient(client);
      setIsInitialized(true);

      // Register XMTP identity in database if we have a valid user
      if (currentUserTokenId && address) {
        try {
          console.log('XMTP: Registering identity in database for userId:', currentUserTokenId);
          const response = await fetch(`${import.meta.env.VITE_API_HOST || 'http://localhost:4000'}/api/xmtp-identity/register`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              userId: currentUserTokenId,
              walletAddress: address,
              installationId: client.installationId,
              identityKey: ''
            })
          });

          if (response.ok) {
            const data = await response.json();
            console.log('XMTP: Identity registered in database:', data);
          } else {
            console.error('XMTP: Failed to register identity:', await response.text());
          }
        } catch (err) {
          console.error('XMTP: Error registering identity in database:', err);
        }
      }

      // Force a re-render by updating a timestamp state to trigger other hook instances
      // This ensures all useXmtpCore() instances pick up the new client
      window.dispatchEvent(new CustomEvent('xmtp-client-initialized', {
        detail: { address: address.toLowerCase() }
      }));
    } catch (error) {
      setXmtpClient(null);
      setIsInitialized(false);
      setInitError(error as Error);
      throw error;
    } finally {
      setIsLoading(false);
    }
  }, [isConnected, xmtpSigner, address, currentUserTokenId]);

  return { xmtpClient, isInitialized, isLoading: isLoading || isChecking, error: initError, initializeClient };
}

/* ---------- exported hooks expected by your Messages.tsx ---------- */

export function useXmtpClient(currentUserTokenId?: number) {
  const core = useXmtpCore(!!currentUserTokenId, currentUserTokenId);

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

  // Function to load conversations from database, then enrich with XMTP data
  const loadConversationsFromDb = useCallback(async () => {
    if (!currentUserTokenId) return;

    console.log('XMTP: Fetching conversation list from database for userId:', currentUserTokenId);

    try {
      // Fetch conversations from database API (source of truth for CAW user context)
      const response = await fetch(
        `${import.meta.env.VITE_API_HOST || 'http://localhost:4000'}/api/conversations/${currentUserTokenId}`
      );

      if (!response.ok) {
        console.error('XMTP: Failed to fetch conversations from database:', response.statusText);
        return;
      }

      const data = await response.json();
      console.log('XMTP: Received conversations from database:', data);

      if (data.conversations) {
        // Get XMTP conversations to map topics to actual conversation IDs
        let xmtpConvMap = new Map<string, any>();
        if (core.xmtpClient) {
          try {
            const xmtpConversations = await core.xmtpClient.conversations.list();
            console.log('XMTP: Found', xmtpConversations.length, 'XMTP conversations');

            // Create a map of topic -> XMTP conversation
            xmtpConversations.forEach(conv => {
              xmtpConvMap.set(conv.id, conv);
              console.log('XMTP: Mapped conversation ID:', conv.id, 'peer:', conv.peerAddress);
            });
          } catch (err) {
            console.error('XMTP: Failed to list XMTP conversations:', err);
          }
        }

        // Transform database conversations to UI format
        const uiConversations: UiConversation[] = data.conversations.map((conv: any) => {
          // Filter out the current user from participants to show only the peer(s)
          const otherParticipants = conv.participants.filter(
            (p: any) => p.userId !== currentUserTokenId
          );

          // Find matching XMTP conversation
          const xmtpConv = xmtpConvMap.get(conv.topic);
          const conversationId = xmtpConv ? xmtpConv.id : conv.topic;

          console.log('XMTP: DB conversation topic:', conv.topic, 'mapped to XMTP ID:', conversationId);

          return {
            id: conversationId, // Use XMTP conversation ID if available, fallback to topic
            type: conv.type,
            participants: otherParticipants.map((p: any) => ({
              userId: p.userId,
              identity: {
                user: {
                  username: p.username,
                  displayName: p.displayName,
                  image: p.avatarUrl,
                  address: p.walletAddress,
                  tokenId: p.userId
                }
              }
            })),
            name: conv.name,
            lastMessageAt: conv.lastMessageAt,
            unreadCount: conv.unreadCount || 0,
          };
        });

        console.log('XMTP: Transformed conversations for UI:', uiConversations);
        setConversations(uiConversations);
      }
    } catch (error) {
      console.error('XMTP: Error fetching conversations from database:', error);
    }
  }, [currentUserTokenId, core.xmtpClient]);

  useEffect(() => {
    if (!core.isInitialized || !currentUserTokenId) return;

    loadConversationsFromDb();
  }, [core.isInitialized, currentUserTokenId, loadConversationsFromDb]);

  // Function to start a new conversation and add it to the list
  const startConversation = useCallback(
    async (peerAddress: string, username?: string, userId?: number) => {
      console.log('[useXmtp] startConversation called with:', { peerAddress, username, userId });
      if (!core.xmtpClient) throw new Error("XMTP not initialized");

      // First check our database if we have username
      let canReceiveFromDb = false;
      if (username) {
        try {
          console.log('XMTP: Checking database for user:', username);
          const response = await fetch(`${import.meta.env.VITE_API_HOST || 'http://localhost:4000'}/api/xmtp-identity/check/${username}`);
          const data = await response.json();
          canReceiveFromDb = data.hasXmtp;
          console.log('XMTP: Database check result:', data);
        } catch (err) {
          console.error('XMTP: Database check failed, will try XMTP network:', err);
        }
      }

      // If database says they have XMTP, skip the network check
      if (!canReceiveFromDb) {
        console.log('XMTP: Checking XMTP network if peer can receive messages:', peerAddress);
        const reachability = await Client.canMessage([
          { identifier: peerAddress, identifierKind: "Ethereum" } as Identifier,
        ]);
        console.log('XMTP: Network reachability result:', reachability);
        const canReceive = reachability.get(peerAddress);
        console.log('XMTP: Can peer receive messages from network?', canReceive);

        if (!canReceive) throw new Error("Peer cannot receive XMTP messages");
      } else {
        console.log('XMTP: Skipping network check, database confirms user has XMTP');
      }

      // Create DM conversation using peer address
      console.log('XMTP: Creating DM with peer address:', peerAddress);
      const dm = await core.xmtpClient.conversations.newDm(peerAddress.toLowerCase());
      console.log('XMTP: DM created successfully with ID:', dm.id);

      // Fetch peer user data to populate participants
      let peerUserData = null;
      try {
        const response = await fetch(`${import.meta.env.VITE_API_HOST || 'http://localhost:4000'}/api/users/by-address/${peerAddress}`);
        if (response.ok) {
          peerUserData = await response.json();
          console.log('XMTP: Fetched peer user data for new conversation:', peerUserData);
        }
      } catch (err) {
        console.error('XMTP: Failed to fetch peer user data:', err);
      }

      const newConversation = {
        id: dm.id,
        type: "DM" as const,
        participants: peerUserData ? [{
          userId: peerUserData.tokenId,
          identity: {
            user: {
              username: peerUserData.username,
              image: peerUserData.avatarUrl,
              address: peerAddress,
              tokenId: peerUserData.tokenId
            }
          }
        }] : [],
        lastMessageAt: new Date().toISOString(),
        unreadCount: 0
      };

      // Persist conversation to database if we have both user IDs
      if (currentUserTokenId && peerUserData?.tokenId) {
        try {
          const payload = {
            userId: currentUserTokenId,
            peerUserId: peerUserData.tokenId,
            topic: dm.id
          };
          console.log('XMTP: Persisting conversation to database with payload:', payload);
          const response = await fetch(`${import.meta.env.VITE_API_HOST || 'http://localhost:4000'}/api/conversations/dm`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
          });

          if (response.ok) {
            const data = await response.json();
            console.log('XMTP: Conversation persisted to database:', data);

            // Reload conversations from database to get the latest list
            await loadConversationsFromDb();
          } else {
            console.error('XMTP: Failed to persist conversation:', await response.text());
          }
        } catch (err) {
          console.error('XMTP: Error persisting conversation to database:', err);
        }
      }

      console.log('XMTP: Returning new conversation:', newConversation);
      return newConversation;
    },
    [core.xmtpClient, currentUserTokenId, loadConversationsFromDb]
  );

  return {
    isInitialized: core.isInitialized,
    isLoading: core.isLoading,
    error: core.error,
    initializeClient: core.initializeClient,
    conversations,
    messages: messagesByConversationId,
    setMessages: setMessagesByConversationId,
    startConversation,
  };
}

export function useConversations() {
  const { xmtpClient, isInitialized } = useXmtpCore();
  const [isLoading, setIsLoading] = useState(false);

  const startConversation = useCallback(
    async (peerAddress: string, username?: string, userId?: number) => {
      // Use xmtpClient from hook state
      if (!xmtpClient) throw new Error("XMTP not initialized");

      // First check our database if we have username
      let canReceiveFromDb = false;
      if (username) {
        try {
          console.log('XMTP: Checking database for user:', username);
          const response = await fetch(`${import.meta.env.VITE_API_HOST || 'http://localhost:4000'}/api/xmtp-identity/check/${username}`);
          const data = await response.json();
          canReceiveFromDb = data.hasXmtp;
          console.log('XMTP: Database check result:', data);
        } catch (err) {
          console.error('XMTP: Database check failed, will try XMTP network:', err);
        }
      }

      // If database says they have XMTP, skip the network check
      if (!canReceiveFromDb) {
        console.log('XMTP: Checking XMTP network if peer can receive messages:', peerAddress);
        const reachability = await Client.canMessage([
          { identifier: peerAddress, identifierKind: "Ethereum" } as Identifier,
        ]);
        console.log('XMTP: Network reachability result:', reachability);
        const canReceive = reachability.get(peerAddress);
        console.log('XMTP: Can peer receive messages from network?', canReceive);

        if (!canReceive) throw new Error("Peer cannot receive XMTP messages");
      } else {
        console.log('XMTP: Skipping network check, database confirms user has XMTP');
      }

      // Create DM conversation using peer address
      console.log('XMTP: Creating DM with peer address:', peerAddress);

      // In XMTP browser SDK v5, newDm accepts the address string directly
      const dm = await xmtpClient.conversations.newDm(peerAddress.toLowerCase());
      console.log('XMTP: DM created successfully with ID:', dm.id);

      // Fetch peer user data to populate participants
      let peerUserData = null;
      try {
        const response = await fetch(`${import.meta.env.VITE_API_HOST || 'http://localhost:4000'}/api/users/by-address/${peerAddress}`);
        if (response.ok) {
          peerUserData = await response.json();
          console.log('XMTP: Fetched peer user data for new conversation:', peerUserData);
        }
      } catch (err) {
        console.error('XMTP: Failed to fetch peer user data:', err);
      }

      return {
        id: dm.id,
        type: "DM" as const,
        participants: peerUserData ? [{
          userId: peerUserData.tokenId,
          identity: {
            user: {
              username: peerUserData.username,
              image: peerUserData.avatarUrl,
              address: peerAddress
            }
          }
        }] : [],
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

// Transform XMTP message to UI message format
function transformXmtpMessage(xmtpMsg: DecodedMessage, currentInboxId?: string): any {
  return {
    id: xmtpMsg.id,
    content: xmtpMsg.content,
    senderId: xmtpMsg.senderInboxId || '', // XMTP uses senderInboxId (this is the inbox ID, not tokenId)
    createdAt: xmtpMsg.sentAtNs ? new Date(Number(xmtpMsg.sentAtNs) / 1_000_000).toISOString() : new Date().toISOString(),
    status: 'SENT',
    conversationId: xmtpMsg.conversationId,
    isFromCurrentUser: currentInboxId ? xmtpMsg.senderInboxId === currentInboxId : false
  };
}

export function useMessages(conversationId: string, _optionalUserId?: number) {
  const { xmtpClient, isInitialized } = useXmtpCore();
  const [isLoading, setIsLoading] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [messages, setMessages] = useState<any[]>([]); // Changed to any[] to allow transformed messages
  const abortRef = useRef<AbortController | null>(null);

  // Get current user's inbox ID for message comparison
  const currentInboxId = xmtpClient?.inboxId;

  useEffect(() => {
    if (!isInitialized || !xmtpClient || !conversationId) return;

    let cancelled = false;
    const controller = new AbortController();
    abortRef.current = controller;

    (async () => {
      setIsLoading(true);
      try {
        // getConversationById returns a DM directly in v5
        const dm = await xmtpClient.conversations.getConversationById(conversationId);
        if (!dm) {
          console.error('XMTP: Conversation not found:', conversationId);
          return;
        }

        console.log('XMTP: Retrieved conversation:', dm);
        console.log('XMTP: Conversation properties:', Object.keys(dm));

        const history = await dm.messages();
        console.log('XMTP: Message history loaded:', history.length, 'messages');
        if (history.length > 0) {
          console.log('XMTP: First message structure:', history[0]);
          console.log('XMTP: First message keys:', Object.keys(history[0]));
        }

        // Transform messages to UI format
        const transformedMessages = history.map(msg => transformXmtpMessage(msg, currentInboxId));
        console.log('XMTP: Transformed messages:', transformedMessages.length);
        if (transformedMessages.length > 0) {
          console.log('XMTP: First transformed message:', transformedMessages[0]);
        }

        if (!cancelled) setMessages(transformedMessages);

        const stream = await xmtpClient.conversations.streamAllMessages({
          consentStates: [ConsentState.Allowed],
          onValue: (msg) => {
            if (msg.conversationId !== conversationId) return;
            const transformedMsg = transformXmtpMessage(msg, currentInboxId);
            setMessages((prev) => (prev.some((m) => m.id === transformedMsg.id) ? prev : [...prev, transformedMsg]));
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
      // Use xmtpClient from hook state
      if (!xmtpClient || !conversationId) return;
      setIsSending(true);
      try {
        // getConversationById returns a DM directly in v5
        const dm = await xmtpClient.conversations.getConversationById(conversationId);
        if (!dm) throw new Error("Conversation not found");

        console.log('XMTP: Sending message to conversation:', dm);
        const sent = await dm.send(payload.content);
        console.log('XMTP: Message sent:', sent);
        const transformedSent = transformXmtpMessage(sent, currentInboxId);
        setMessages((prev) => [...prev, transformedSent]); // optimistic; stream confirms
      } finally {
        setIsSending(false);
      }
    },
    [isInitialized, xmtpClient, conversationId]
  );

  const markAsRead = useCallback(() => {}, []);

  return { messages, isLoading, isSending, sendMessage, markAsRead };
}

