/** Pinned constants. The embedding contract lives here and nowhere else. */
export const EMBEDDING_DIMS = 512;
export const OLLAMA_EMBED_MODEL = "qwen3-embedding:0.6b";
export const OMLX_EMBED_MODEL = "Qwen3-Embedding-0.6B-8bit";
export const OLLAMA_URL = process.env.JARVIS_OLLAMA_URL ?? "http://localhost:11434";
export const OMLX_URL = process.env.JARVIS_OMLX_URL ?? "http://127.0.0.1:8000/v1";

export const EMBED_BATCH_SIZE = Number(process.env.JARVIS_EMBED_BATCH_SIZE ?? 8) || 8;
export const EMBED_CONCURRENCY = Number(process.env.JARVIS_EMBED_CONCURRENCY ?? 1) || 1;

export const CHUNK_TARGET_TOKENS = 400;
export const CHUNK_OVERLAP_TOKENS = 50;
export const TOKENS_PER_WORD = 0.75;
export const CHUNK_TARGET_WORDS = Math.round(CHUNK_TARGET_TOKENS / TOKENS_PER_WORD); // 534 (533.33 → 533); spec says 534
export const CHUNK_OVERLAP_WORDS = Math.round(CHUNK_OVERLAP_TOKENS / TOKENS_PER_WORD); // 67
export const CHUNK_MAX_CHARS = 1600;

export const RRF_K = 60;
export const SEMANTIC_OVERFETCH = 10;
export const SEARCH_DEFAULT_LIMIT = 10;

export const EMBEDDING_EDGE_THRESHOLD = 0.5;
export const EMBEDDING_EDGE_TOPK = 5;
export const EMBEDDING_EDGE_KNN = 50;
export const AUTO_EDGE_WINDOW = 15;
export const AUTO_EDGE_TOPK = 5;
export const BACKLINK_MIN_TITLE = 4;
export const ENTITY_COSINE_THRESHOLD = 0.85;

export const ENRICH_TARGET_VERSION = 1;
export const ENRICH_MAX_TOKENS = 6000;
export const ENRICH_PIECE_CHARS = 80_000;
export const ENRICH_TAG_CAP = 8;

export const REFINE_BATCH = 8;
export const REFINE_MAX_TOKENS = 4000;
export const REFINE_BLURB_CHARS = 500;

export const CLEANUP_TARGET_VERSION = 1;
export const CLEANUP_PIECE_CHARS = 8000;
export const CLEANUP_MAX_TOKENS = 4000;
export const CLEANUP_GLOSSARY_LINES = 40;
export const CLEANUP_MIN_OUTPUT_RATIO = 0.5;

export const MEETING_SUMMARY_MAX_TOKENS = 3000;
export const ASK_DEFAULT_LIMIT = 5;
export const ASK_MAX_LIMIT = 20;
export const ASK_CONTEXT_CHARS = 24_000;
export const ASK_MAX_CONTEXT_CHARS = 100_000;
export const ASK_MAX_TOKENS = 2000;

export const LLM_TIMEOUT_MS = Number(process.env.JARVIS_LLM_TIMEOUT_MS ?? 120_000) || 120_000;
export const PROBE_TIMEOUT_MS = 2000;
export const OLLAMA_TAGS_CACHE_MS = 10_000;

export const DEFAULT_PORT = 7281;
export const BROWSE_LIMIT = 20;
export const RECENT_LIMIT = 10;

export const TASK_SUGGEST_QUERY_CHARS = 300;
export const TASK_SUGGEST_MIN_TERM = 4;
export const TASK_SUGGEST_LIMIT = 5;

export const INBOX_SETTLE_MS = 60_000;
export const WHISPER_TIMEOUT_MS = 30 * 60_000;

export const SOURCES = ["web", "youtube", "meeting", "note", "paste", "pdf", "task", "briefing", "presentation"] as const;
export type Source = (typeof SOURCES)[number];
export const ENTITY_KINDS = ["person", "team", "product", "service", "concept"] as const;
export type EntityKind = (typeof ENTITY_KINDS)[number];
export const RELATIONS = ["related", "same_topic", "references", "supplements", "contradicts", "follows_up", "mentions", "part_of"] as const;
export type Relation = (typeof RELATIONS)[number];
export const CREATED_BY = ["backlink", "auto", "embedding", "entity", "llm", "manual", "briefing"] as const;
export type CreatedBy = (typeof CREATED_BY)[number];
