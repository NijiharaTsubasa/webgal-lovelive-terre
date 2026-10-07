export interface GltfCatalogEntry {
  type: string;
  name: string;
  config: string;
  src?: string;
  description?: string;
  motionGroup?: string;
  fade_in?: number;
  fade_out?: number;
}
export interface CatalogInventory {
  files: Set<string>;
  cache?: Map<string, any>;
  cancelled?: boolean;
  generations?: Map<string, number>;
  runtime?: { resources: GltfCatalogEntry[]; issues: string[] };
}
