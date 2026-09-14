import type { ReleaseCandidate, ToolEnvelope, DataSourceStatus } from "@mediabox/contracts";
import { createToolEnvelope } from "./envelope.js";
import { createReleaseRef } from "./references.js";

export const RANKING_VERSION = "1.1.0";

/**
 * Audio languages beyond Spanish and English (policy 1.1.0): the language name
 * Radarr/Sonarr report, whole title tokens, and the ways a user may ask for it.
 * Before 1.1.0 any other requirement was ignored, even when strict, so a
 * "Japanese audio" request still ranked (and let the agent propose) a Latino release.
 */
const OTHER_LANGUAGES: Record<string, { label: string; aliases: string[]; tokens: string[] }> = {
  ja: { label: "Japanese", aliases: ["ja", "jpn", "japanese", "japones", "japonesa"], tokens: ["japanese", "jpn"] },
  fr: { label: "French", aliases: ["fr", "fre", "fra", "french", "frances", "francesa"], tokens: ["french", "vff", "truefrench"] },
  de: { label: "German", aliases: ["de", "ger", "deu", "german", "aleman", "alemana"], tokens: ["german", "ger"] },
  it: { label: "Italian", aliases: ["it", "ita", "italian", "italiano", "italiana"], tokens: ["italian", "ita"] },
  pt: { label: "Portuguese", aliases: ["pt", "por", "pt-br", "portuguese", "portugues", "portuguesa"], tokens: ["portuguese", "ptbr"] },
  ko: { label: "Korean", aliases: ["ko", "kor", "korean", "coreano", "coreana"], tokens: ["korean", "kor"] },
  zh: { label: "Chinese", aliases: ["zh", "chi", "zho", "chinese", "chino", "china", "mandarin"], tokens: ["chinese", "mandarin", "cantonese"] },
  ru: { label: "Russian", aliases: ["ru", "rus", "russian", "ruso", "rusa"], tokens: ["russian", "rus"] },
};

const fold = (s: string) => s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();

function otherLanguageKey(requested: string): string | undefined {
  const r = fold(requested);
  return Object.entries(OTHER_LANGUAGES).find(([, l]) => l.aliases.includes(r))?.[0];
}

function hasOtherLanguage(raw: RawReleaseItem, key: string): boolean {
  const lang = OTHER_LANGUAGES[key];
  const label = fold(lang.label);
  if ((raw.languages || []).some((l) => fold(l.name || "").split(/[^a-z]+/)[0] === label)) return true;
  const tokens = new Set(fold(raw.title).split(/[^a-z0-9]+/).filter(Boolean));
  return lang.tokens.some((t) => tokens.has(t));
}

export interface ReleaseRankingOptions {
  minSeeders?: number;
  requiredAudioLanguage?: string; // e.g. "latino", "es-419", "en", "es"
  strictAudioLanguage?: boolean;
  preferredResolution?: string; // e.g. "1080p", "720p", "2160p"
  maxSizeBytes?: number;
}

export interface ReleaseSearchContext {
  installationId: string;
  ownerId: string;
  conversationId: string;
  snapshotId?: string;
  /** Sonarr seriesId / Radarr movieId the releases belong to; bound into every releaseRef. */
  entityId?: number;
}

export interface RawReleaseItem {
  guid: string;
  title: string;
  size: number;
  seeders?: number;
  leechers?: number;
  protocol?: "torrent" | "usenet";
  indexer?: string;
  indexerId?: number;
  quality?: {
    quality?: {
      name?: string;
      resolution?: number;
    };
  };
  languages?: Array<{ id?: number; name?: string }>;
  customFormatScore?: number;
}

/**
 * Normalizes and analyzes language properties from raw release data and title.
 */
export function analyzeReleaseLanguages(raw: RawReleaseItem): {
  detectedLanguages: string[];
  isLatinSpanish: boolean;
  isCastilianSpanish: boolean;
  isEnglish: boolean;
  isUnknown: boolean;
} {
  const titleLower = raw.title.toLowerCase();
  const explicitNames = (raw.languages || []).map((l) => (l.name || "").toLowerCase());

  const hasLatinoMarker =
    titleLower.includes("latino") ||
    titleLower.includes("latin") ||
    titleLower.includes("es-419") ||
    explicitNames.includes("spanish latino") ||
    explicitNames.includes("latino");

  const hasCastilianMarker =
    titleLower.includes("castellano") ||
    titleLower.includes("castilian") ||
    titleLower.includes("spa-esp");

  const hasGenericSpanish =
    explicitNames.includes("spanish") ||
    titleLower.includes("spanish") ||
    titleLower.includes("esp");

  const isLatinSpanish = hasLatinoMarker;
  const isCastilianSpanish = hasCastilianMarker || (hasGenericSpanish && !hasLatinoMarker);
  const isEnglish = explicitNames.includes("english") || titleLower.includes("english") || titleLower.includes("eng");

  const detectedLanguages: string[] = [];
  if (isLatinSpanish) detectedLanguages.push("Spanish (Latin America)");
  if (isCastilianSpanish) detectedLanguages.push("Spanish (Castilian)");
  if (isEnglish) detectedLanguages.push("English");
  for (const [key, lang] of Object.entries(OTHER_LANGUAGES)) {
    if (hasOtherLanguage(raw, key)) detectedLanguages.push(lang.label);
  }

  const isUnknown = detectedLanguages.length === 0;
  if (isUnknown) {
    detectedLanguages.push("Unknown");
  }

  return {
    detectedLanguages,
    isLatinSpanish,
    isCastilianSpanish,
    isEnglish,
    isUnknown,
  };
}

/**
 * Deterministically ranks release candidates according to versioned policy (CAT-03).
 * Hard requirements reject; preferences only adjust the score.
 */
export function rankReleaseCandidate(
  raw: RawReleaseItem,
  options: ReleaseRankingOptions = {}
): {
  score: number;
  reasons: string[];
  rejected: boolean;
  rejections: string[];
  qualityName: string;
  resolution: string;
  languages: string[];
} {
  const reasons: string[] = [`Ranking policy v${RANKING_VERSION}`];
  const rejections: string[] = [];
  let rejected = false;
  let score = 100; // Base score

  const seeders = raw.seeders ?? 0;
  const minSeeders = options.minSeeders ?? 1;

  // Hard constraint 1: Dead torrents / minimum seeders
  if ((raw.protocol ?? "torrent") === "torrent" && seeders < minSeeders) {
    rejected = true;
    rejections.push(`Seeders (${seeders}) below minimum threshold (${minSeeders})`);
  } else if ((raw.protocol ?? "torrent") === "torrent") {
    reasons.push(`Has ${seeders} seeders (above threshold)`);
    score += Math.min(seeders * 2, 40);
  }

  // Hard constraint 2: maximum size
  if (options.maxSizeBytes !== undefined && raw.size > options.maxSizeBytes) {
    rejected = true;
    rejections.push(`Size ${raw.size} exceeds maximum ${options.maxSizeBytes}`);
  }

  // Language analysis
  const lang = analyzeReleaseLanguages(raw);
  const languages = lang.detectedLanguages;

  // Hard constraint 3: Strict audio language requirement
  if (options.requiredAudioLanguage) {
    const req = options.requiredAudioLanguage.toLowerCase();
    const isStrict = options.strictAudioLanguage ?? false;

    if (req === "latino" || req === "es-419") {
      if (lang.isLatinSpanish) {
        score += 60;
        reasons.push("Confirmed Latin American Spanish audio (+60)");
      } else if (lang.isUnknown) {
        if (isStrict) {
          rejected = true;
          rejections.push("Language is unknown; cannot satisfy strict Latin Spanish requirement (CAT-03)");
        } else {
          score -= 40;
          reasons.push("Unknown language when Latin Spanish preferred (-40)");
        }
      } else if (lang.isCastilianSpanish) {
        if (isStrict) {
          rejected = true;
          rejections.push("Castilian Spanish audio does not satisfy strict Latin Spanish requirement (CAT-03)");
        } else {
          score -= 20;
          reasons.push("Castilian Spanish audio when Latin Spanish preferred (-20)");
        }
      } else {
        if (isStrict) {
          rejected = true;
          rejections.push("Non-Spanish audio does not satisfy strict Latin Spanish requirement");
        } else {
          score -= 50;
          reasons.push("Non-Spanish audio when Latin Spanish preferred (-50)");
        }
      }
    } else if (req === "es" || req === "spanish") {
      if (lang.isLatinSpanish || lang.isCastilianSpanish) {
        score += 40;
        reasons.push("Confirmed Spanish audio (+40)");
      } else if (lang.isUnknown) {
        if (isStrict) {
          rejected = true;
          rejections.push("Unknown language; cannot satisfy strict Spanish requirement");
        } else {
          score -= 30;
          reasons.push("Unknown language when Spanish preferred (-30)");
        }
      } else if (isStrict) {
        rejected = true;
        rejections.push("Does not contain required Spanish audio");
      } else {
        score -= 30;
        reasons.push("Non-Spanish audio when Spanish preferred (-30)");
      }
    } else if (req === "en" || req === "english") {
      if (lang.isEnglish) {
        score += 40;
        reasons.push("Confirmed English audio (+40)");
      } else if (lang.isUnknown) {
        if (isStrict) {
          rejected = true;
          rejections.push("Unknown language; cannot satisfy strict English requirement");
        } else {
          score -= 30;
          reasons.push("Unknown language when English preferred (-30)");
        }
      } else if (isStrict) {
        rejected = true;
        rejections.push("Does not contain required English audio");
      } else {
        score -= 30;
        reasons.push("Non-English audio when English preferred (-30)");
      }
    } else {
      const key = otherLanguageKey(req);
      const label = key ? OTHER_LANGUAGES[key].label : options.requiredAudioLanguage;
      if (key && hasOtherLanguage(raw, key)) {
        score += 40;
        reasons.push(`Confirmed ${label} audio (+40)`);
      } else if (isStrict) {
        rejected = true;
        rejections.push(
          !key
            ? `Unsupported language requirement '${options.requiredAudioLanguage}'; it cannot be confirmed`
            : lang.isUnknown
              ? `Unknown language; cannot satisfy strict ${label} requirement`
              : `Does not contain required ${label} audio`
        );
      } else {
        score -= 30;
        reasons.push(`${label} audio not confirmed when preferred (-30)`);
      }
    }
  }

  // Quality & Resolution preferences
  const qualityName = raw.quality?.quality?.name || "Unknown";
  const titleUpper = raw.title.toUpperCase();
  let resolution = "unknown";
  if (titleUpper.includes("2160P") || titleUpper.includes("4K")) resolution = "2160p";
  else if (titleUpper.includes("1080P")) resolution = "1080p";
  else if (titleUpper.includes("720P")) resolution = "720p";
  else if (raw.quality?.quality?.resolution) resolution = `${raw.quality.quality.resolution}p`;

  if (options.preferredResolution) {
    if (resolution === options.preferredResolution.toLowerCase()) {
      score += 35;
      reasons.push(`Matches preferred resolution ${resolution} (+35)`);
    } else {
      score -= 10;
      reasons.push(`Resolution ${resolution} does not match preferred ${options.preferredResolution} (-10)`);
    }
  }

  // Custom format score bonus from upstream
  if (raw.customFormatScore) {
    score += raw.customFormatScore;
    reasons.push(`Custom format score from indexer: ${raw.customFormatScore}`);
  }

  return {
    score: Math.max(score, 0),
    reasons,
    rejected,
    rejections,
    qualityName,
    resolution,
    languages,
  };
}

export async function findAndRankReleases(
  mediaId: string,
  mediaType: "movie" | "series",
  rawReleases: RawReleaseItem[],
  rankingOptions: ReleaseRankingOptions,
  context: ReleaseSearchContext,
  sources?: DataSourceStatus[]
): Promise<ToolEnvelope<ReleaseCandidate[]>> {
  const snapshotId = context.snapshotId || `snap_${Date.now()}`;
  const candidates: ReleaseCandidate[] = [];
  const service = mediaType === "series" ? "sonarr" : "radarr";

  for (const raw of rawReleases) {
    const ranked = rankReleaseCandidate(raw, rankingOptions);
    const releaseRef = createReleaseRef(
      {
        guid: raw.guid,
        title: raw.title,
        indexerId: raw.indexerId,
        mediaId,
        snapshotId,
        serviceEntityIds: {
          service,
          ...(context.entityId !== undefined ? { [service === "sonarr" ? "sonarrId" : "radarrId"]: context.entityId } : {}),
        },
      },
      {
        installationId: context.installationId,
        ownerId: context.ownerId,
        conversationId: context.conversationId,
      }
    );

    candidates.push({
      releaseRef,
      guid: raw.guid,
      title: raw.title,
      sizeBytes: raw.size,
      seeders: raw.seeders ?? 0,
      leechers: raw.leechers,
      protocol: raw.protocol || "torrent",
      indexer: raw.indexer || "Unknown",
      indexerId: raw.indexerId,
      quality: ranked.qualityName,
      resolution: ranked.resolution,
      languages: ranked.languages,
      score: ranked.score,
      reasons: ranked.reasons,
      rejected: ranked.rejected,
      rejections: ranked.rejections.length ? ranked.rejections : undefined,
    });
  }

  // Sort deterministically: non-rejected first, score DESC, seeders DESC, guid ASC (stable)
  candidates.sort((a, b) => {
    if (a.rejected !== b.rejected) return a.rejected ? 1 : -1;
    if (b.score !== a.score) return b.score - a.score;
    if (b.seeders !== a.seeders) return b.seeders - a.seeders;
    return a.guid.localeCompare(b.guid);
  });

  return createToolEnvelope<ReleaseCandidate[]>({
    data: candidates,
    sources: sources ?? [
      {
        source: service,
        observedAt: new Date().toISOString(),
        snapshotId,
        completeness: "complete",
      },
    ],
    budget: {
      itemsReturned: candidates.length,
      itemsAvailable: candidates.length,
    },
  });
}
