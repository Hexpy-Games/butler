export interface ImageUsageValues { generated: number; edited: number; estimated_usd: number | null; }
export interface ImageUsageView {
  days: number;
  models: (ImageUsageValues & { model_ref: string; display_name: string; provider_id: string })[];
  total: ImageUsageValues;
}
