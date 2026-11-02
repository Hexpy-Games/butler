export interface GlossaryArea {
  id: string;
  ko: string;
  en: string;
}

export interface GlossaryPart extends GlossaryArea {
  parent: string | null;
  area: string;
  desc: string;
  ds: string[];
  app: string[];
  avoid: string[];
}
