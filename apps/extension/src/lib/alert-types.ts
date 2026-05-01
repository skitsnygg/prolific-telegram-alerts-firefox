export type Provider = "prolific" | "cloudresearch";

export type SupportedDevice = "Desktop" | "Tablet" | "Mobile";

export interface StudyPayload {
  provider: Provider;
  title: string;
  reward: string;
  completionTime?: string | null;
  places?: string | null;
  url: string;
  postedAt: string;
  supportedDevices?: SupportedDevice[];
  mobileSupported: boolean;
}

export interface SummaryStudyPayload {
  title: string;
  reward: string;
  completionTime?: string | null;
  places?: string | null;
  url: string;
  supportedDevices?: SupportedDevice[];
  mobileSupported: boolean;
}

export interface SummaryPayload {
  provider: Provider;
  totalNew: number;
  topStudies: SummaryStudyPayload[];
}
