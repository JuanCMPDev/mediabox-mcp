import { afterEach, describe, expect, it, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { resolveVirtualCall } from "../../../chat-core/src/tool-router.js";
import { registerJellyfinTools } from "./jellyfin.js";
import { registerDownloadTools } from "./downloads.js";

const upstream = vi.hoisted(() => ({ jellyfin: vi.fn(), sonarr: vi.fn(), radarr: vi.fn(), qbit: vi.fn() }));
vi.mock("../helpers/api.js", () => ({
  jfApi: upstream.jellyfin, sonarrApi: upstream.sonarr, radarrApi: upstream.radarr,
  jfCountByParent: vi.fn(),
  textResult: (data: unknown) => ({ content: [{ type: "text", text: JSON.stringify(data) }] }),
}));
vi.mock("../helpers/qbittorrent.js", () => ({ qbitApi: upstream.qbit }));

async function connect() {
  const server = new McpServer({ name: "read-fixture", version: "1" });
  registerJellyfinTools(server);
  registerDownloadTools(server);
  const client = new Client({ name: "read-test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server };
}

afterEach(() => vi.resetAllMocks());

describe("virtual reads through the registered MCP schema", () => {
  it("lists movies by year upstream without a title search and reports the filtered total", async () => {
    const library = [
      { Id: "m1", Name: "Another Round", Type: "Movie", ProductionYear: 2020 },
      { Id: "m2", Name: "Soul", Type: "Movie", ProductionYear: 2020 },
      { Id: "m3", Name: "2020 The Movie", Type: "Movie", ProductionYear: 2018 },
      { Id: "s1", Name: "The Queen's Gambit", Type: "Series", ProductionYear: 2020 },
    ];
    upstream.jellyfin.mockImplementation(async (endpoint: string) => {
      const params = new URLSearchParams(endpoint.split("?")[1]);
      expect(params.has("searchTerm")).toBe(false);
      const filtered = library.filter((item) => item.Type === params.get("IncludeItemTypes") && item.ProductionYear === Number(params.get("Years")));
      const offset = Number(params.get("StartIndex"));
      return { Items: filtered.slice(offset, offset + Number(params.get("Limit"))), TotalRecordCount: filtered.length };
    });
    const { client, server } = await connect();
    try {
      const { tools } = await client.listTools();
      const schema = tools.find((tool) => tool.name === "jellyfin_search")!.inputSchema;
      expect(schema.properties).toHaveProperty("year");
      const call = resolveVirtualCall("media_query", { action: "list", type: "Movie", year: 2020, page: 2, pageSize: 1, query: "2020" });
      const result = await client.callTool({ name: call.tool, arguments: call.args });
      expect(result.isError).not.toBe(true);
      const payload = JSON.parse((result.content as any)[0].text);
      expect(payload).toMatchObject({ total: 2, results: [{ id: "m2", name: "Soul", year: 2020 }], pagination: { page: 2, totalPages: 2, hasMore: false } });
      expect(upstream.jellyfin).toHaveBeenCalledTimes(1);
    } finally { await client.close(); await server.close(); }
  });

  it("keeps title search and details routing while validating year/page before upstream I/O", async () => {
    upstream.jellyfin.mockResolvedValue({ Items: [], TotalRecordCount: 0 });
    const { client, server } = await connect();
    try {
      const call = resolveVirtualCall("media_query", { action: "search", query: "Amélie & friends", year: 2001, type: "Movie" });
      await client.callTool({ name: call.tool, arguments: call.args });
      const params = new URLSearchParams(upstream.jellyfin.mock.calls[0][0].split("?")[1]);
      expect(params.get("searchTerm")).toBe("Amélie & friends");
      expect(params.get("Years")).toBe("2001");
      expect(resolveVirtualCall("media_query", { action: "details", showId: "series-id" }).tool).toBe("show_details");
      for (const args of [{ year: 20.5 }, { year: 10000 }, { page: 0 }, { pageSize: 51 }]) {
        const result = await client.callTool({ name: "jellyfin_search", arguments: args });
        expect(result.isError).toBe(true);
      }
      expect(upstream.jellyfin).toHaveBeenCalledTimes(1);
    } finally { await client.close(); await server.close(); }
  });

  it("routes queue status through a read-only MCP endpoint and retains partial provenance", async () => {
    upstream.sonarr.mockResolvedValue({ records: [{ id: 7, title: "Severance.S02", status: "downloading", size: 200, sizeleft: 100 }], totalRecords: 1 });
    upstream.radarr.mockRejectedValue(new Error("secret upstream URL"));
    upstream.qbit.mockResolvedValue([]);
    const { client, server } = await connect();
    try {
      const call = resolveVirtualCall("downloads", { action: "status", queueIds: [7], torrentHashes: ["fake"], deleteFiles: true });
      expect(call).toEqual({ tool: "download_queue", args: { source: "all" } });
      const result = await client.callTool({ name: call.tool, arguments: call.args });
      const payload = JSON.parse((result.content as any)[0].text);
      expect(payload.status).toBe("partial");
      expect(payload.sources[1].completeness).toBe("unavailable");
      expect(payload.data.queues[0].records[0]).toMatchObject({ title: "Severance.S02", progressPercent: 50 });
      expect(payload.data.queues[1].records).toBeNull();
      expect(payload.data.queues[2].records).toEqual([]);
      expect(result.structuredContent).toEqual(payload);
      for (const fn of [upstream.sonarr, upstream.radarr, upstream.qbit]) {
        expect(fn).toHaveBeenCalledTimes(1);
        expect(fn.mock.calls[0][1]).toBe("GET");
        expect(fn.mock.calls[0][2]).toBeUndefined();
      }
      for (const args of [{ source: "purge" }, { pageSize: 6 }]) {
        expect((await client.callTool({ name: "download_queue", arguments: args })).isError).toBe(true);
      }
      expect(upstream.qbit).toHaveBeenCalledTimes(1);
    } finally { await client.close(); await server.close(); }
  });
});
