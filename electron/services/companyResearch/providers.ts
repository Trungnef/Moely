import { tavily } from '@tavily/core';
import { CompanyDossier, CompanyResearchContext, CompanyResearchEvidence, CompanyResearchProvider } from './types';

const DEFAULT_COMPETITORS = ['Category peers', 'Adjacent incumbents', 'Emerging startups'];

function summarizeEvidence(evidence: CompanyResearchEvidence[], fallback: string): string {
    if (!evidence.length) return fallback;
    return evidence.slice(0, 3).map((item) => item.snippet).join(' ');
}

function dedupe(values: string[], max: number = 8): string[] {
    const seen = new Set<string>();
    const output: string[] = [];
    for (const value of values) {
        const normalized = value.trim();
        if (!normalized) continue;
        const key = normalized.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        output.push(normalized);
        if (output.length >= max) break;
    }
    return output;
}

function estimateDifficulty(title: string): 'easy' | 'medium' | 'hard' | 'very_hard' {
    const t = (title || '').toLowerCase();
    if (/intern|junior|associate/.test(t)) return 'easy';
    if (/staff|principal|director|head|vp|chief/.test(t)) return 'very_hard';
    if (/senior|lead|manager/.test(t)) return 'hard';
    return 'medium';
}

function estimateSalaryRange(title: string, years: number, location: string): { min: number; max: number; confidence: 'low' | 'medium' | 'high' } {
    const y = Math.max(1, years || 1);
    const titleBoost = /staff|principal|director|head|vp|chief/i.test(title) ? 60000
        : /senior|lead|manager/i.test(title) ? 35000
        : /intern|junior|associate/i.test(title) ? -15000
        : 0;
    const geoBoost = /sf|san francisco|bay area|new york|seattle/i.test(location || '') ? 30000 : 0;

    const base = 80000 + y * 8500 + titleBoost + geoBoost;
    return {
        min: Math.max(45000, Math.round(base / 5000) * 5000),
        max: Math.max(70000, Math.round((base + 40000) / 5000) * 5000),
        confidence: y >= 5 ? 'medium' : 'low',
    };
}

export class TavilyCompanyResearchProvider implements CompanyResearchProvider {
    public readonly name = 'tavily';
    private client: ReturnType<typeof tavily>;

    constructor(apiKey: string) {
        this.client = tavily({ apiKey });
    }

    public async research(context: CompanyResearchContext): Promise<CompanyDossier> {
        const queryBase = `${context.companyName} company overview products services business model competitors hiring trends interview process culture recent news`;
        const queryRole = `${context.companyName} ${context.jobTitle || ''} interview questions hiring expectations ${context.technologies?.join(' ') || ''}`;

        const [overviewRes, roleRes] = await Promise.all([
            this.client.search(queryBase, {
                searchDepth: 'advanced',
                maxResults: 8,
                includeRawContent: true,
                topic: 'general',
            } as any),
            this.client.search(queryRole, {
                searchDepth: 'basic',
                maxResults: 6,
                includeRawContent: true,
                topic: 'news',
            } as any),
        ]);

        const allResults = dedupe([
            ...(overviewRes?.results || []).map((r: any) => JSON.stringify(r)),
            ...(roleRes?.results || []).map((r: any) => JSON.stringify(r)),
        ], 20).map((s) => JSON.parse(s));

        const evidence: CompanyResearchEvidence[] = allResults.map((result: any) => ({
            title: result.title || 'Result',
            url: result.url || result.link,
            snippet: (result.content || result.snippet || result.raw_content || '').slice(0, 420),
            source: result.url ? new URL(result.url).hostname : 'web',
            score: typeof result.score === 'number' ? result.score : undefined,
        }));

        const snippets = evidence.map((item) => item.snippet).join(' ');
        const products = dedupe((snippets.match(/\b(platform|api|product|suite|service|tool|cloud|application)s?\b/gi) || []).map((x) => x.toLowerCase()), 6);
        const competitors = dedupe(
            evidence
                .flatMap((item) => item.snippet.split(/[.;]/g))
                .filter((part) => /compet|alternative|versus|vs\.?/i.test(part))
                .map((part) => part.trim().slice(0, 80)),
            6,
        );

        const years = Math.max(1, context.yearsExperience || 1);
        const salary = estimateSalaryRange(context.jobTitle || 'Target Role', years, context.location || 'US');

        return {
            company_overview: summarizeEvidence(evidence, `${context.companyName} is an organization operating in a competitive market.`),
            products_and_services: products.length ? products : ['Core product suite', 'Platform services'],
            business_model: summarizeEvidence(evidence.filter((item) => /revenue|pricing|enterprise|subscription|market/i.test(item.snippet)), `${context.companyName} appears to operate a mix of B2B and product-led revenue motions.`),
            competitors: competitors.length ? competitors : DEFAULT_COMPETITORS,
            recent_news: dedupe(evidence.slice(0, 6).map((item) => `${item.title}${item.url ? ` (${item.url})` : ''}`), 6),
            hiring_trends: summarizeEvidence(evidence.filter((item) => /hiring|job|talent|headcount|team/i.test(item.snippet)), `Recent hiring signals suggest ${context.companyName} is prioritizing delivery and technical execution.`),
            interview_insights: summarizeEvidence(evidence.filter((item) => /interview|assessment|technical|behavioral|culture/i.test(item.snippet)), `Expect interviews to cover role execution, collaboration, and business impact.`),
            company_culture_summary: summarizeEvidence(evidence.filter((item) => /culture|values|mission|team|work/i.test(item.snippet)), `${context.companyName} appears to value ownership, communication, and fast learning.`),
            interview_focus: `For ${context.jobTitle || 'this role'}, emphasize ${context.technologies?.slice(0, 5).join(', ') || 'core domain strengths'}, measurable impact, and cross-functional execution.`,
            interview_difficulty: estimateDifficulty(context.jobTitle || ''),
            salary_estimates: [{
                title: context.jobTitle || 'Target Role',
                location: context.location || 'US',
                min: salary.min,
                max: salary.max,
                currency: 'USD',
                confidence: salary.confidence,
            }],
            sources: ['Tavily Search'],
            evidence,
            generatedAt: new Date().toISOString(),
        };
    }
}

export class LocalCompanyResearchProvider implements CompanyResearchProvider {
    public readonly name = 'local';

    public async research(context: CompanyResearchContext): Promise<CompanyDossier> {
        const years = Math.max(1, context.yearsExperience || 1);
        const salary = estimateSalaryRange(context.jobTitle || 'Target Role', years, context.location || 'US');
        return {
            company_overview: `${context.companyName} research is generated locally from available resume/JD context. Add a Tavily API key for live web-backed depth.`,
            products_and_services: ['Primary product line', 'Supporting services'],
            business_model: 'Likely combines subscription, enterprise contracts, and service-based revenue depending on market segment.',
            competitors: DEFAULT_COMPETITORS,
            recent_news: ['No live web news available in local-only mode.'],
            hiring_trends: 'Likely hiring for ownership, rapid execution, and technical depth in role-specific stacks.',
            interview_insights: `Prepare quantified impact stories, architecture choices, and trade-off discussions for ${context.jobTitle || 'the role'}.`,
            company_culture_summary: 'Expect emphasis on collaboration, communication clarity, and ability to drive results in ambiguity.',
            interview_focus: `Highlight strengths in ${context.technologies?.slice(0, 5).join(', ') || 'relevant tools and systems'} and outcomes tied to business goals.`,
            interview_difficulty: estimateDifficulty(context.jobTitle || ''),
            salary_estimates: [{
                title: context.jobTitle || 'Target Role',
                location: context.location || 'US',
                min: salary.min,
                max: salary.max,
                currency: 'USD',
                confidence: 'low',
            }],
            sources: ['Local Persona Engine'],
            evidence: [],
            generatedAt: new Date().toISOString(),
        };
    }
}
