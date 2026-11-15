declare const _default: import("@yunzai-ng/types").PluginDefinition<{
    enabled: boolean;
    parseInPrivate: boolean;
    ignorePrefixes: string[];
    sendMode: "info-only" | "with-video";
    renderCard: boolean;
    cardAsForward: boolean;
    atSender: boolean;
    maxVideoSizeMB: number;
    videoQuality: "auto" | "4k" | "1080p60" | "1080p" | "720p" | "480p";
    parseCacheTTL: number;
    groupWhitelist: string[];
    groupBlacklist: string[];
    debug: boolean;
}>;
export default _default;
