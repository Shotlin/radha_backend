import type { MarketingLeadRow } from '@/db/schema/marketing-leads';

import type { DateRange } from './analytics.types';

/**
 * BE-29 — Lead management types.
 */

export type LeadSource =
  | 'contact_form'
  | 'demo_request'
  | 'whatsapp'
  | 'phone'
  | 'email'
  | 'referral'
  | 'other';

export type LeadStatus =
  | 'new'
  | 'contacted'
  | 'qualified'
  | 'demo_scheduled'
  | 'demo_completed'
  | 'converted'
  | 'lost'
  | 'spam';

export interface CreateLeadInput {
  name: string;
  email: string;
  mobile?: string;
  company?: string;
  message?: string;
  source: LeadSource;
  utmSource?: string;
  utmMedium?: string;
  utmCampaign?: string;
  pageUrl?: string;
  referrer?: string;
  metadata?: Record<string, unknown>;
}

export interface UpdateLeadInput {
  status?: LeadStatus;
  notes?: string;
  assignedTo?: string;
  lostReason?: string;
}

export interface ListLeadsFilter {
  status?: LeadStatus;
  source?: LeadSource;
  utmCampaign?: string;
  cursor?: string;
  limit?: number;
}

export interface ConversionStats {
  totalLeads: number;
  contacted: number;
  qualified: number;
  converted: number;
  lost: number;
  spam: number;
  contactRate: number;
  qualificationRate: number;
  conversionRate: number;
}

export type MarketingLead = MarketingLeadRow;

export interface ILeadsService {
  createLead(input: CreateLeadInput, ipHash?: string, actorUserId?: string): Promise<MarketingLead>;
  list(
    filters: ListLeadsFilter,
  ): Promise<{ data: MarketingLead[]; nextCursor: string | null; hasMore: boolean }>;
  findById(id: string): Promise<MarketingLead | null>;
  updateStatus(
    id: string,
    status: LeadStatus,
    notes: string | undefined,
    actorUserId: string,
  ): Promise<MarketingLead>;
  convert(leadId: string, tenantId: string, actorUserId: string): Promise<MarketingLead>;
  getConversionRate(dateRange: DateRange): Promise<ConversionStats>;
}
