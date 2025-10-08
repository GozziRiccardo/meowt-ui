// src/abi.ts
export const GAME = (import.meta.env as any).VITE_GAME_ADDRESS as `0x${string}`;

export const GAME_ABI = [
  { name: "activeMessageId", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  {
    name: "messages", type: "function", stateMutability: "view", inputs: [{ type: "uint256" }],
    outputs: [
      { name: "id", type: "uint256" },
      { name: "author", type: "address" },
      { name: "stake", type: "uint256" },
      { name: "startTime", type: "uint256" },
      { name: "B0", type: "uint256" },
      { name: "uri", type: "string" },
      { name: "contentHash", type: "bytes32" },
      { name: "likes", type: "uint256" },
      { name: "dislikes", type: "uint256" },
      { name: "feePot", type: "uint256" },
      { name: "resolved", type: "bool" },
      { name: "nuked", type: "bool" },
      { name: "winnerSide", type: "uint8" },
      { name: "sharePerVote", type: "uint256" },
      { name: "seedFromStake", type: "uint256" },
    ]
  },
  { name: "endTime", type: "function", stateMutability: "view", inputs: [{ type: "uint256" }], outputs: [{ type: "uint256" }] },
  { name: "remainingSeconds", type: "function", stateMutability: "view", inputs: [{ type: "uint256" }], outputs: [{ type: "uint256" }] },
  { name: "gloryRemaining", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { name: "requiredStakeToReplace", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },

  { name: "kSecPerToken", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { name: "epsilonBps", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { name: "floorBps", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { name: "minFloorMEOW", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { name: "engagementBps", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { name: "capMultiplierBps", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },

  { name: "voteFeeLike", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { name: "voteFeeDislike", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { name: "minVotingBalance", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },

  { name: "moderationRequired", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] },
  { name: "moderationSigner", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { name: "modFlagged", type: "function", stateMutability: "view", inputs: [{ type: "uint256" }], outputs: [{ type: "bool" }] },

  { name: "post", type: "function", stateMutability: "nonpayable",
    inputs: [{ type: "string" },{ type: "bytes32" },{ type: "uint256" },{ type: "uint256" },{ type: "uint256" },{ type: "bytes" }], outputs: [] },
  { name: "replaceMessage", type: "function", stateMutability: "nonpayable",
    inputs: [{ type: "string" },{ type: "bytes32" },{ type: "uint256" },{ type: "uint256" },{ type: "uint256" },{ type: "bytes" }], outputs: [] },
  { name: "vote", type: "function", stateMutability: "nonpayable", inputs: [{ type: "bool" }], outputs: [] },

  { name: "boost", type: "function", stateMutability: "nonpayable", inputs: [], outputs: [] },
  { name: "boostCost", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { name: "boostedRemaining", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { name: "boostCooldownRemaining", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { name: "isReplaceBlocked", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] },

  { name: "windows", type: "function", stateMutability: "view", inputs: [], outputs: [
    { name: "postImm", type: "uint256" }, { name: "glory", type: "uint256" }, { name: "freeze", type: "uint256" },
  ]},
  { name: "boostWindows", type: "function", stateMutability: "view", inputs: [], outputs: [
    { name: "window", type: "uint256" }, { name: "gap", type: "uint256" },
  ]},

  { name: "voteOf", type: "function", stateMutability: "view", inputs: [{ type: "uint256" }, { type: "address" }], outputs: [{ type: "uint8" }] },
  { name: "resolveIfExpired", type: "function", stateMutability: "nonpayable", inputs: [], outputs: [] },
  { name: "claim", type: "function", stateMutability: "nonpayable", inputs: [{ type: "uint256" }], outputs: [] },
  { name: "nextMessageId", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { name: "claimed", type: "function", stateMutability: "view", inputs: [{ type: "uint256" }, { type: "address" }], outputs: [{ type: "bool" }] },
] as const;
