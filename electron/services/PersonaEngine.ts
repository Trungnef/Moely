import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import mammoth from 'mammoth';
import { DatabaseManager } from '../db/DatabaseManager';
import { CredentialsManager } from './CredentialsManager';
import { CompanyDossier } from './companyResearch/types';
import { LocalCompanyResearchProvider, TavilyCompanyResearchProvider } from './companyResearch/providers';

type SearchResult = {
    category: string;
    title: string;
    snippet: string;
    score: number;
};

type ExperienceNode = {
    title: string;
    organization: string;
    startDate?: string;
    endDate?: string;
    text: string;
};

type NegotiationOutput = {
    salary_range: {
        currency: string;
        min: number;
        max: number;
        confidence: 'low' | 'medium' | 'high';
    };
    negotiation_strategy: string[];
    strengths_to_emphasize: string[];
    compensation_risk_analysis: string[];
    offer_comparison_framework: string[];
    counter_offer_suggestions: string[];
    negotiation_scripts: {
        opening: string;
        anchoring: string;
        pushback_response: string;
        close: string;
    };
    recruiter_response_drafts: {
        initial_reply: string;
        follow_up: string;
        final_acceptance_if_aligned: string;
    };
    offer_evaluation_report: string;
    opening_line?: string;
    justification?: string;
    counter_offer_fallback?: string;
    updatedAt: string;
};

type PersonaProfile = {
    identity: {
        name: string;
        email?: string;
        phone?: string;
        location?: string;
        headline?: string;
    };
    professionalIdentity: {
        currentRole: string;
        seniority: string;
        domainFocus: string[];
        topStrengths: string[];
    };
    skills: string[];
    skillsGraph: Array<{ skill: string; weight: number; sources: string[] }>;
    experienceTimeline: Array<{
        title: string;
        organization: string;
        startDate?: string;
        endDate?: string;
        summary: string;
    }>;
    projectKnowledgeBase: Array<{
        title: string;
        summary: string;
        technologies: string[];
    }>;
    education: string[];
    certifications: string[];
    careerSummary: string;
    customContext: string;
    activeJD: {
        title: string;
        company: string;
        level: string;
        location?: string;
        technologies: string[];
        requirements: string[];
        keywords: string[];
    } | null;
    matchInsights: {
        overlapSkills: string[];
        gapSkills: string[];
        interviewPreparation: string[];
        personalizedCareerAdvice: string[];
    };
    hasActiveJD: boolean;
    experienceCount: number;
    projectCount: number;
    nodeCount: number;
    totalExperienceYears: number;
    updatedAt: string;
};

const APP_STATE_KEYS = {
    resume: 'persona:resume',
    resumeId: 'persona:resume_id',
    jd: 'persona:jd',
    jdId: 'persona:jd_id',
    profile: 'persona:profile',
    mode: 'persona:mode',
    negotiation: 'persona:negotiation',
    companyDossier: 'persona:company_dossier',
} as const;

const STOP_WORDS = new Set([
    'the', 'and', 'for', 'with', 'that', 'this', 'from', 'you', 'your', 'are', 'was', 'were', 'have', 'has', 'had',
    'will', 'can', 'into', 'about', 'over', 'through', 'using', 'use', 'used', 'our', 'their', 'they', 'them', 'but',
    'not', 'all', 'any', 'per', 'via', 'also', 'its', 'than', 'then', 'job', 'role', 'work', 'team', 'years',
    'year', 'month', 'months', 'resume', 'description', 'requirements', 'responsibilities', 'including', 'across',
]);

const SKILL_KEYWORDS = [
    'javascript', 'typescript', 'python', 'java', 'c++', 'c#', 'go', 'rust', 'node.js', 'react', 'next.js', 'angular',
    'vue', 'sql', 'postgresql', 'mysql', 'mongodb', 'redis', 'aws', 'azure', 'gcp', 'docker', 'kubernetes', 'terraform',
    'graphql', 'rest', 'microservices', 'machine learning', 'data analysis', 'pandas', 'numpy', 'scikit-learn',
    'tensorflow', 'pytorch', 'nlp', 'system design', 'leadership', 'product management', 'communication',
    'project management', 'agile', 'scrum', 'salesforce', 'hubspot', 'excel', 'power bi', 'tableau',
];

const QUERY_SYNONYMS: Record<string, string[]> = {
    lead: ['leadership', 'managed', 'manager'],
    architecture: ['system', 'design', 'microservices', 'distributed'],
    frontend: ['react', 'next.js', 'javascript', 'typescript', 'ui'],
    backend: ['api', 'node.js', 'python', 'database', 'microservices'],
    data: ['analytics', 'sql', 'tableau', 'power', 'bi', 'machine', 'learning'],
    ai: ['machine', 'learning', 'nlp', 'llm', 'tensorflow', 'pytorch'],
    sales: ['pipeline', 'revenue', 'enterprise', 'quota', 'growth'],
};

const EMBEDDING_DIM = 192;

export class PersonaEngine {
    private static instance: PersonaEngine;
    private db = DatabaseManager.getInstance();
    private llmHelper: any = null;

    public setLLMHelper(llmHelper: any): void {
        this.llmHelper = llmHelper;
    }

    public static getInstance(): PersonaEngine {
        if (!PersonaEngine.instance) {
            PersonaEngine.instance = new PersonaEngine();
        }
        return PersonaEngine.instance;
    }

    public async ingestResume(filePath: string): Promise<{ success: boolean; error?: string }> {
        try {
            const content = await this.readDocumentText(filePath);
            if (!content.trim()) return { success: false, error: 'No text extracted from resume.' };
            const id = crypto.randomUUID();
            const uploadedAt = new Date().toISOString();
            this.db.setAppState(APP_STATE_KEYS.resumeId, id);
            this.db.setAppState(APP_STATE_KEYS.resume, JSON.stringify({ id, filePath, content, uploadedAt }));
            this.persistResumeDocument(id, filePath, content, uploadedAt);
            this.setMode(true);
            await this.refreshProfileFromStored();
            return { success: true };
        } catch (error: any) {
            return { success: false, error: error?.message ?? 'Failed to ingest resume.' };
        }
    }

    public async ingestJobDescription(filePath: string): Promise<{ success: boolean; error?: string }> {
        try {
            const content = await this.readDocumentText(filePath);
            if (!content.trim()) return { success: false, error: 'No text extracted from job description.' };
            const id = crypto.randomUUID();
            const uploadedAt = new Date().toISOString();
            this.db.setAppState(APP_STATE_KEYS.jdId, id);
            this.db.setAppState(APP_STATE_KEYS.jd, JSON.stringify({ id, filePath, content, uploadedAt }));
            this.persistJobDescriptionDocument(id, filePath, content, uploadedAt);
            await this.refreshProfileFromStored();
            return { success: true };
        } catch (error: any) {
            return { success: false, error: error?.message ?? 'Failed to ingest job description.' };
        }
    }

    public getStatus(): { hasProfile: boolean; profileMode: boolean; name?: string; role?: string; totalExperienceYears?: number } {
        const profile = this.getProfileData();
        return {
            hasProfile: !!profile,
            profileMode: this.isProfileModeEnabled(),
            name: profile?.identity.name,
            role: profile?.professionalIdentity.currentRole,
            totalExperienceYears: profile?.totalExperienceYears ?? 0,
        };
    }

    public setMode(enabled: boolean): { success: boolean } {
        this.db.setAppState(APP_STATE_KEYS.mode, enabled ? '1' : '0');
        return { success: true };
    }

    public async deleteResume(): Promise<{ success: boolean }> {
        const resumeId = this.db.getAppState(APP_STATE_KEYS.resumeId);
        this.db.deleteAppState(APP_STATE_KEYS.resume);
        this.db.deleteAppState(APP_STATE_KEYS.resumeId);
        this.db.deleteAppState(APP_STATE_KEYS.profile);
        this.deleteExplicitDocument('resumes', resumeId);
        this.clearResumeNodes();
        this.setMode(false);
        await this.refreshProfileFromStored();
        return { success: true };
    }

    public async deleteJobDescription(): Promise<{ success: boolean }> {
        const jdId = this.db.getAppState(APP_STATE_KEYS.jdId);
        this.db.deleteAppState(APP_STATE_KEYS.jd);
        this.db.deleteAppState(APP_STATE_KEYS.jdId);
        this.db.deleteAppState(APP_STATE_KEYS.companyDossier);
        this.db.deleteAppState(APP_STATE_KEYS.negotiation);
        this.deleteExplicitDocument('job_descriptions', jdId);
        await this.refreshProfileFromStored();
        return { success: true };
    }

    public getProfileData(): PersonaProfile | null {
        const raw = this.db.getAppState(APP_STATE_KEYS.profile);
        if (!raw) return null;
        try {
            return JSON.parse(raw) as PersonaProfile;
        } catch {
            return null;
        }
    }

    public getCareerState(): {
        success: boolean;
        status: ReturnType<PersonaEngine['getStatus']>;
        profile: PersonaProfile | null;
        negotiation: NegotiationOutput | null;
        companyDossier: CompanyDossier | null;
        resume: { id?: string; filePath?: string; uploadedAt?: string } | null;
        jobDescription: { id?: string; filePath?: string; uploadedAt?: string } | null;
    } {
        return {
            success: true,
            status: this.getStatus(),
            profile: this.getProfileData(),
            negotiation: this.readJsonState<NegotiationOutput>(APP_STATE_KEYS.negotiation),
            companyDossier: this.readJsonState<CompanyDossier>(APP_STATE_KEYS.companyDossier),
            resume: this.getStoredDocumentMeta(APP_STATE_KEYS.resume),
            jobDescription: this.getStoredDocumentMeta(APP_STATE_KEYS.jd),
        };
    }

    public getPromptContext(maxChars: number = 3200): string {
        if (!this.isProfileModeEnabled()) return '';
        const profile = this.getProfileData();
        if (!profile) return '';

        const lines: string[] = [];
        lines.push('<profile_intelligence>');
        lines.push(`<professional_identity>${profile.identity.name || 'Unknown'} · ${profile.professionalIdentity.currentRole}</professional_identity>`);
        if (profile.skills.length > 0) lines.push(`<skills>${profile.skills.slice(0, 20).join(', ')}</skills>`);
        if (profile.experienceTimeline.length > 0) {
            const timeline = profile.experienceTimeline.slice(0, 4)
                .map((e) => `${e.title} at ${e.organization}${e.startDate ? ` (${e.startDate}-${e.endDate || 'Present'})` : ''}`)
                .join(' | ');
            lines.push(`<experience_timeline>${timeline}</experience_timeline>`);
        }
        if (profile.projectKnowledgeBase.length > 0) {
            const projects = profile.projectKnowledgeBase.slice(0, 3)
                .map((p) => `${p.title}: ${p.summary}`)
                .join(' | ');
            lines.push(`<project_knowledge>${projects}</project_knowledge>`);
        }
        if (profile.hasActiveJD && profile.activeJD) {
            lines.push(`<job_description>${profile.activeJD.title} @ ${profile.activeJD.company}; tech: ${profile.activeJD.technologies.join(', ')}</job_description>`);
            lines.push(`<resume_match>overlap: ${profile.matchInsights.overlapSkills.slice(0, 8).join(', ') || 'n/a'}; gaps: ${profile.matchInsights.gapSkills.slice(0, 8).join(', ') || 'n/a'}</resume_match>`);
            lines.push(`<interview_prep>${profile.matchInsights.interviewPreparation.join(' | ')}</interview_prep>`);
            lines.push(`<career_advice>${profile.matchInsights.personalizedCareerAdvice.join(' | ')}</career_advice>`);
        }
        if (profile.customContext.trim()) lines.push(`<custom_context>${profile.customContext.trim()}</custom_context>`);

        const closing = '</profile_intelligence>';
        const joined = lines.join('\n');
        // Truncate the body, never the closing tag (an unterminated block confuses the model).
        const body = joined.length + closing.length + 1 > maxChars
            ? joined.slice(0, Math.max(0, maxChars - closing.length - 1))
            : joined;
        return `${body}\n${closing}`;
    }

    /**
     * Grounding block for LIVE interview answers (auto-answer / "What to answer").
     *
     * Uses the RAW resume and JD text rather than the regex-parsed profile: the
     * parser keeps one line per job and drops the detail bullets, which are exactly
     * what a STAR answer needs. Custom notes are always included (they are the
     * user's explicit instructions); resume/JD/company only while Profile Mode is on.
     */
    public getLiveAnswerContext(question: string, opts: { resumeChars?: number; jdChars?: number } = {}): string {
        const resumeChars = opts.resumeChars ?? 7000;
        const jdChars = opts.jdChars ?? 3500;
        const clean = (s: string) => (s || '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
        const cap = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}\n[...truncated]` : s);
        const parts: string[] = [];

        try {
            if (this.isProfileModeEnabled()) {
                const readContent = (key: string): string => {
                    const raw = this.db.getAppState(key);
                    if (!raw) return '';
                    try { return clean((JSON.parse(raw) as { content?: string }).content || ''); } catch { return ''; }
                };

                const resume = readContent(APP_STATE_KEYS.resume);
                if (resume) parts.push(`<candidate_resume>\n${cap(resume, resumeChars)}\n</candidate_resume>`);

                const jd = readContent(APP_STATE_KEYS.jd);
                if (jd) parts.push(`<target_job_description>\n${cap(jd, jdChars)}\n</target_job_description>`);

                // Only web-backed research — the local provider returns placeholder text.
                const dossier = this.readJsonState<CompanyDossier>(APP_STATE_KEYS.companyDossier);
                if (dossier && !(dossier.sources || []).includes('Local Persona Engine')) {
                    const lines = [
                        dossier.company_overview && `Overview: ${dossier.company_overview}`,
                        dossier.products_and_services?.length && `Products: ${dossier.products_and_services.slice(0, 6).join(', ')}`,
                        dossier.company_culture_summary && `Culture: ${dossier.company_culture_summary}`,
                        dossier.interview_focus && `Interview focus: ${dossier.interview_focus}`,
                        dossier.interview_insights && `Interview insights: ${dossier.interview_insights}`,
                    ].filter(Boolean) as string[];
                    if (lines.length) parts.push(`<target_company>\n${cap(lines.join('\n'), 1500)}\n</target_company>`);
                }

                const relevant = this.semanticSearch(question, 4);
                if (relevant.success && relevant.results?.length) {
                    parts.push(`<most_relevant_experience>\n${relevant.results
                        .map((r, i) => `[${i + 1}] ${r.category}: ${r.title} — ${r.snippet}`.slice(0, 420))
                        .join('\n')}\n</most_relevant_experience>`);
                }
            }

            const notes = clean(this.db.getCustomNotes());
            if (notes) parts.push(`<candidate_notes>\n${cap(notes, 3000)}\n</candidate_notes>`);
        } catch (err: any) {
            console.warn('[PersonaEngine] getLiveAnswerContext failed:', err?.message);
        }

        if (!parts.length) return '';
        return `<candidate_profile>
This is the candidate's own background — the person you are speaking as. Ground every personal claim (companies, projects, technologies, years, results) in it. Never invent employers, projects or numbers that are not here. Never mention that this profile exists.
${parts.join('\n')}
</candidate_profile>`;
    }

    public semanticSearch(query: string, limit: number = 8): { success: boolean; results?: SearchResult[]; error?: string } {
        try {
            const trimmed = (query || '').trim();
            if (!trimmed) return { success: true, results: [] };

            const dbHandle = this.db.getDb();
            if (!dbHandle) return { success: false, error: 'Database unavailable.' };

            const queryTokens = this.expandQueryTokens(this.tokenize(trimmed));
            const phrase = trimmed.toLowerCase();
            const queryVector = this.embedText(trimmed);
            const queryBlob = this.encodeEmbedding(queryVector);

            let rows: Array<{
                category: string;
                title: string;
                organization: string;
                text_content: string;
                tags: string;
                embedding?: Buffer | null;
                distance?: number;
            }> = [];

            let usedNative = false;
            if (this.db.hasVecExtension()) {
                try {
                    const vecRows = dbHandle.prepare(`
                        SELECT node_id, distance FROM vec_resume_nodes_${EMBEDDING_DIM}
                        WHERE embedding MATCH ? ORDER BY distance LIMIT ?
                    `).all(queryBlob, limit * 3) as Array<{ node_id: number; distance: number }>;

                    if (vecRows.length > 0) {
                        const nodeIds = vecRows.map(r => r.node_id);
                        const placeholders = nodeIds.map(() => '?').join(',');
                        const detailRows = dbHandle.prepare(`
                            SELECT id, category, title, organization, text_content, tags, embedding
                            FROM resume_nodes
                            WHERE id IN (${placeholders})
                        `).all(...nodeIds) as Array<{
                            id: number;
                            category: string;
                            title: string;
                            organization: string;
                            text_content: string;
                            tags: string;
                            embedding?: Buffer | null;
                        }>;

                        const detailMap = new Map(detailRows.map(r => [r.id, r]));
                        for (const vecRow of vecRows) {
                            const details = detailMap.get(vecRow.node_id);
                            if (details) {
                                rows.push({
                                    ...details,
                                    distance: vecRow.distance
                                });
                            }
                        }
                        usedNative = true;
                    }
                } catch (e) {
                    console.error('[PersonaEngine] Native vector search query failed, falling back to JS:', e);
                }
            }

            if (!usedNative || rows.length === 0) {
                rows = dbHandle.prepare('SELECT category, title, organization, text_content, tags, embedding FROM resume_nodes').all() as any[];
            }

            const ranked = rows
                .map((row) => {
                    const corpus = `${row.title || ''} ${row.organization || ''} ${row.tags || ''} ${row.text_content || ''}`.toLowerCase();
                    const corpusTokens = new Set(this.tokenize(corpus));
                    let lexicalScore = 0;

                    for (const token of queryTokens) {
                        if (corpusTokens.has(token)) lexicalScore += 1;
                        if (token.length > 4 && corpus.includes(token)) lexicalScore += 0.35;
                    }
                    if (corpus.includes(phrase)) lexicalScore += 2.2;

                    const similarity = row.distance !== undefined
                        ? (1 - row.distance)
                        : (row.embedding ? this.cosineSimilarity(queryVector, this.decodeEmbedding(row.embedding)) : 0);

                    const vectorScore = similarity * 2.0;

                    return {
                        category: row.category || 'profile',
                        title: row.title || row.organization || 'Profile Node',
                        snippet: this.buildSnippet(row.text_content || corpus, trimmed),
                        score: lexicalScore + vectorScore,
                    };
                })
                .filter((item) => item.score > 0)
                .sort((a, b) => b.score - a.score)
                .slice(0, Math.max(1, Math.min(limit, 20)));

            return { success: true, results: ranked };
        } catch (error: any) {
            return { success: false, error: error?.message ?? 'Semantic search failed.' };
        }
    }

    public queryContext(query: string, limit: number = 8): { success: boolean; query: string; answer: string; context: string; results: SearchResult[]; error?: string } {
        const search = this.semanticSearch(query, limit);
        if (!search.success) {
            return { success: false, query, answer: '', context: '', results: [], error: search.error };
        }

        const results = search.results || [];
        const profile = this.getProfileData();
        const contextLines = [
            this.getPromptContext(2200),
            ...results.map((item, index) => `[${index + 1}] ${item.category}: ${item.title} - ${item.snippet}`),
        ].filter(Boolean);

        const answer = results.length
            ? `Most relevant career context: ${results.slice(0, 3).map((item) => `${item.title} (${item.category})`).join(', ')}. ${profile?.hasActiveJD ? `Active JD match gaps: ${profile.matchInsights.gapSkills.slice(0, 4).join(', ') || 'none detected'}.` : ''}`.trim()
            : 'No matching career context found yet. Upload a resume, job description, or add custom context to expand the knowledge base.';

        return {
            success: true,
            query,
            answer,
            context: contextLines.join('\n'),
            results,
        };
    }

    public async generateNegotiationScript(force: boolean = false): Promise<{ success: boolean; script?: NegotiationOutput; error?: string }> {
        try {
            const profile = this.getProfileData();
            if (!profile) return { success: false, error: 'No profile available.' };
            if (!profile.activeJD) {
                return { success: false, error: 'Upload a job description before generating negotiation guidance.' };
            }

            if (!force) {
                const cached = this.db.getAppState(APP_STATE_KEYS.negotiation);
                if (cached) {
                    try {
                        return { success: true, script: JSON.parse(cached) as NegotiationOutput };
                    } catch {
                        // regenerate below
                    }
                }
            }

            const range = this.estimateCompRange(profile.totalExperienceYears, profile.activeJD.title, profile.activeJD.location || profile.identity.location || 'US');
            const overlapSkills = profile.matchInsights.overlapSkills.slice(0, 6);
            const gapSkills = profile.matchInsights.gapSkills.slice(0, 5);
            const strengths = profile.professionalIdentity.topStrengths.slice(0, 4);

            let script: NegotiationOutput = {
                salary_range: {
                    currency: 'USD',
                    min: range.min,
                    max: range.max,
                    confidence: range.confidence,
                },
                negotiation_strategy: [
                    'Anchor using market-aligned range and role scope before discussing flexibility.',
                    'Lead with measurable impact stories tied to revenue, cost, reliability, or delivery speed.',
                    'Trade on package components strategically: base, bonus, equity, sign-on, and review cycle.',
                    'Use timeline leverage: maintain momentum while requesting written confirmation of compensation terms.',
                ],
                strengths_to_emphasize: strengths.length ? strengths : [
                    `Depth in ${profile.skills.slice(0, 3).join(', ')}`,
                    'Execution ownership across cross-functional teams',
                    'Consistent delivery under ambiguous requirements',
                ],
                compensation_risk_analysis: [
                    'Title inflation risk: confirm responsibilities and leveling rubric in writing.',
                    'Variable-heavy risk: verify payout rules and historical attainment for bonus targets.',
                    'Equity opacity risk: request vesting details, refresh policy, and strike/tax guidance.',
                    gapSkills.length ? `Skill-gap risk for JD alignment: ${gapSkills.join(', ')}` : 'Low immediate skill-gap risk based on current overlap.',
                ],
                offer_comparison_framework: [
                    'Compare guaranteed cash first (base + sign-on + minimum bonus).',
                    'Normalize vesting and refresh windows for equity comparability.',
                    'Factor in role scope, manager quality, and growth trajectory as weighted multipliers.',
                    'Assess interview signals and execution expectations versus support/resources available.',
                ],
                counter_offer_suggestions: [
                    `Target base counter between ${Math.round((range.min + range.max) / 2 / 5000) * 5000} and ${range.max.toLocaleString()} USD based on market and impact scope.`,
                    'If base is fixed, negotiate sign-on bonus and first-review timeline with pre-defined bump criteria.',
                    'Request written role success metrics for first 90 days to align compensation discussions.',
                    overlapSkills.length ? `Re-anchor around role-critical overlap: ${overlapSkills.join(', ')}.` : 'Re-anchor around transferable strengths and delivery velocity.',
                ],
                negotiation_scripts: {
                    opening: `I am excited about ${profile.activeJD.title} at ${profile.activeJD.company}. Based on scope and market data, I am targeting ${range.min.toLocaleString()}-${range.max.toLocaleString()} USD base.`,
                    anchoring: `Given my background in ${profile.skills.slice(0, 4).join(', ')} and proven outcomes across ${profile.experienceCount} experience entries, I believe the upper half of that range is appropriate.`,
                    pushback_response: 'I am flexible on package structure, but I would like guaranteed cash to reflect the role impact and expectations discussed.',
                    close: 'If we can align on compensation and growth trajectory, I am prepared to move forward quickly.',
                },
                recruiter_response_drafts: {
                    initial_reply: `Thank you for sharing the offer. I am very interested. Based on the role scope, market, and my relevant track record, I am targeting ${range.min.toLocaleString()}-${range.max.toLocaleString()} USD base. Happy to discuss total package tradeoffs.`,
                    follow_up: 'Following up on compensation alignment. I remain excited about the role and would appreciate confirmation on base, bonus mechanics, equity details, and review timeline so I can finalize quickly.',
                    final_acceptance_if_aligned: 'Thank you for working through details. The revised package aligns with my expectations, and I am happy to accept. Please share final paperwork and start-date logistics.',
                },
                offer_evaluation_report: `Current target band: ${range.min.toLocaleString()}-${range.max.toLocaleString()} USD. Prioritize guaranteed cash, then variable comp quality, then equity realism. Strong fit signals: ${overlapSkills.join(', ') || 'broad technical overlap'}. Recommended: negotiate with anchor-first strategy and convert tradeoffs into written terms.`,
                opening_line: `I am excited about ${profile.activeJD.title} at ${profile.activeJD.company}. Based on scope and market data, I am targeting ${range.min.toLocaleString()}-${range.max.toLocaleString()} USD base.`,
                justification: `My strongest leverage is ${strengths.join('; ') || profile.skills.slice(0, 4).join(', ')}. The role-critical overlap includes ${overlapSkills.join(', ') || 'execution ownership and adaptable problem solving'}.`,
                counter_offer_fallback: 'If base salary is constrained, I would like to explore sign-on bonus, equity, bonus structure, and a written six-month compensation review tied to clear success metrics.',
                updatedAt: new Date().toISOString(),
            };

            if (this.llmHelper && this.getTargetLanguageFromInputs() === 'Vietnamese') {
                script = await this.translateScriptToVietnamese(script);
            }

            this.db.setAppState(APP_STATE_KEYS.negotiation, JSON.stringify(script));
            this.persistNegotiationHistory(profile, script);
            return { success: true, script };
        } catch (error: any) {
            return { success: false, error: error?.message ?? 'Failed to generate negotiation script.' };
        }
    }

    public getNegotiationState(): { success: boolean; state: any; isActive: boolean } {
        const raw = this.db.getAppState(APP_STATE_KEYS.negotiation);
        if (!raw) return { success: true, state: null, isActive: false };
        try {
            const state = JSON.parse(raw);
            return { success: true, state, isActive: true };
        } catch {
            return { success: true, state: null, isActive: false };
        }
    }

    public resetNegotiation(): { success: boolean } {
        this.db.deleteAppState(APP_STATE_KEYS.negotiation);
        return { success: true };
    }

    public async researchCompany(companyName: string): Promise<{ success: boolean; dossier: CompanyDossier | null; searchQuotaExhausted: boolean; error?: string }> {
        try {
            const profile = this.getProfileData();
            const activeJD = profile?.activeJD;
            const contextHash = this.hashContext([
                companyName,
                activeJD?.title || '',
                activeJD?.location || profile?.identity.location || '',
                (activeJD?.technologies || []).join(','),
                (activeJD?.requirements || []).join(','),
                profile?.customContext || '',
            ].join('|'));

            const cached = this.getCompanyResearchCache(companyName, contextHash);
            if (cached) {
                this.db.setAppState(APP_STATE_KEYS.companyDossier, JSON.stringify(cached));
                return { success: true, dossier: cached, searchQuotaExhausted: false };
            }

            const tavilyKey = CredentialsManager.getInstance().getTavilyApiKey();
            const provider = tavilyKey ? new TavilyCompanyResearchProvider(tavilyKey) : new LocalCompanyResearchProvider();
            let dossier = await provider.research({
                companyName,
                jobTitle: activeJD?.title,
                location: activeJD?.location || profile?.identity.location,
                yearsExperience: profile?.totalExperienceYears || 1,
                technologies: activeJD?.technologies || profile?.skills || [],
                requirements: activeJD?.requirements || [],
                customContext: profile?.customContext,
            });

            if (this.llmHelper && this.getTargetLanguageFromInputs() === 'Vietnamese') {
                dossier = await this.translateDossierToVietnamese(dossier);
            }

            this.setCompanyResearchCache(companyName, contextHash, provider.name, dossier);
            this.db.setAppState(APP_STATE_KEYS.companyDossier, JSON.stringify(dossier));
            this.persistCompanyDossier(companyName, contextHash, dossier);
            return { success: true, dossier, searchQuotaExhausted: false };
        } catch (error: any) {
            return { success: false, dossier: null, searchQuotaExhausted: false, error: error?.message || 'Company research failed.' };
        }
    }

    public async refreshProfileFromStored(): Promise<void> {
        const resumeRaw = this.db.getAppState(APP_STATE_KEYS.resume);
        const jdRaw = this.db.getAppState(APP_STATE_KEYS.jd);
        const customContext = this.db.getCustomNotes();

        if (!resumeRaw) {
            this.db.deleteAppState(APP_STATE_KEYS.profile);
            this.clearResumeNodes();
            return;
        }

        let resumeContent = '';
        try {
            resumeContent = (JSON.parse(resumeRaw) as { content?: string }).content || '';
        } catch {
            resumeContent = '';
        }

        if (!resumeContent) {
            this.db.deleteAppState(APP_STATE_KEYS.profile);
            this.clearResumeNodes();
            return;
        }

        let jdContent = '';
        if (jdRaw) {
            try {
                jdContent = (JSON.parse(jdRaw) as { content?: string }).content || '';
            } catch {
                jdContent = '';
            }
        }

        let profile = this.generateProfile(resumeContent, jdContent, customContext);

        if (this.llmHelper && this.getTargetLanguageFromInputs() === 'Vietnamese') {
            profile = await this.translateProfileToVietnamese(profile);
        }

        this.db.setAppState(APP_STATE_KEYS.profile, JSON.stringify(profile));
        this.persistProfileSnapshot(profile);
        this.storeProfileNodes(profile);
    }

    private isProfileModeEnabled(): boolean {
        return this.db.getAppState(APP_STATE_KEYS.mode) === '1';
    }

    private async readDocumentText(filePath: string): Promise<string> {
        const ext = path.extname(filePath).toLowerCase();

        if (ext === '.txt' || ext === '.md') return fs.readFileSync(filePath, 'utf8');

        if (ext === '.pdf') {
            const pdfParseLib: any = require('pdf-parse');
            const buffer = fs.readFileSync(filePath);
            const parsed = typeof pdfParseLib === 'function'
                ? await pdfParseLib(buffer)
                : pdfParseLib.PDFParse
                    ? await new pdfParseLib.PDFParse({ data: buffer }).getText()
                    : null;
            return parsed?.text || '';
        }

        if (ext === '.docx') {
            const result = await mammoth.extractRawText({ path: filePath });
            return result.value || '';
        }

        throw new Error('Unsupported file type. Allowed: PDF, DOCX, TXT, MD');
    }

    private generateProfile(resumeText: string, jdText: string, customContext: string): PersonaProfile {
        const cleanedResume = this.cleanText(resumeText);
        const cleanedJD = this.cleanText(jdText);

        const identity = this.extractIdentity(cleanedResume);
        const skills = this.extractSkills(cleanedResume, cleanedJD, customContext);
        const experience = this.extractExperience(cleanedResume);
        const projects = this.extractProjects(cleanedResume);
        const education = this.extractSectionItems(cleanedResume, ['education']);
        const certifications = this.extractSectionItems(cleanedResume, ['certification', 'certifications']);
        const activeJD = cleanedJD ? this.extractJobDescription(cleanedJD) : null;
        const years = this.estimateExperienceYears(experience, cleanedResume);

        const skillsGraph = skills.map((skill, idx) => ({
            skill,
            weight: Math.max(0.1, (skills.length - idx) / Math.max(1, skills.length)),
            sources: this.detectSkillSources(skill, cleanedResume, cleanedJD, customContext),
        }));

        const currentRole = experience[0]?.title || activeJD?.title || 'Professional';
        const professionalIdentity = {
            currentRole,
            seniority: this.deriveSeniority(currentRole),
            domainFocus: skills.slice(0, 5),
            topStrengths: this.buildTopStrengths(skills, experience, projects),
        };

        const matchInsights = this.buildMatchInsights(skills, activeJD);
        const careerSummary = this.buildCareerSummary(identity.name, years, currentRole, skills, experience.length, projects.length, activeJD, customContext, matchInsights);

        return {
            identity,
            professionalIdentity,
            skills,
            skillsGraph,
            experienceTimeline: experience.map((item) => ({
                title: item.title,
                organization: item.organization,
                startDate: item.startDate,
                endDate: item.endDate,
                summary: item.text,
            })),
            projectKnowledgeBase: projects.map((project) => ({
                title: project.title,
                summary: project.text,
                technologies: skills.filter((s) => project.text.toLowerCase().includes(s.toLowerCase())).slice(0, 5),
            })),
            education,
            certifications,
            careerSummary,
            customContext: customContext || '',
            activeJD,
            matchInsights,
            hasActiveJD: !!activeJD,
            experienceCount: experience.length,
            projectCount: projects.length,
            nodeCount: experience.length + projects.length + education.length + certifications.length + skills.length,
            totalExperienceYears: years,
            updatedAt: new Date().toISOString(),
        };
    }

    private buildMatchInsights(skills: string[], jd: PersonaProfile['activeJD']): PersonaProfile['matchInsights'] {
        if (!jd) {
            return {
                overlapSkills: [],
                gapSkills: [],
                interviewPreparation: [
                    'Prepare 3 quantified achievement stories using STAR format.',
                    'Map your experience to expected role impact and ownership scope.',
                ],
                personalizedCareerAdvice: [
                    'Keep documenting measurable outcomes to strengthen future negotiation leverage.',
                    'Prioritize projects that show end-to-end ownership and business impact.',
                ],
            };
        }

        const skillSet = new Set(skills.map((s) => s.toLowerCase()));
        const overlapSkills = jd.technologies.filter((t) => skillSet.has(t.toLowerCase())).slice(0, 12);
        const gapSkills = jd.technologies.filter((t) => !skillSet.has(t.toLowerCase())).slice(0, 8);
        return {
            overlapSkills,
            gapSkills,
            interviewPreparation: [
                `Practice deep dives on ${overlapSkills.slice(0, 4).join(', ') || 'your strongest stack areas'} with architecture trade-offs.`,
                'Prepare one leadership story and one technical incident story with measurable outcomes.',
                'Draft first-90-day execution plan aligned to role responsibilities.',
            ],
            personalizedCareerAdvice: [
                gapSkills.length ? `Close highlighted gaps: ${gapSkills.slice(0, 4).join(', ')} through focused project reps.` : 'You have strong stack alignment; focus on senior-level impact narratives.',
                'Keep a reusable impact log with revenue/cost/time metrics for future interviews and promotions.',
                'Prioritize opportunities that compound domain depth and stakeholder influence.',
            ],
        };
    }

    private extractIdentity(text: string): PersonaProfile['identity'] {
        const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
        const email = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0];
        const phone = text.match(/\+?\d[\d\s().-]{7,}\d/)?.[0];

        let name = 'User';
        const firstLine = lines[0] || '';
        if (firstLine && firstLine.length < 70 && !firstLine.includes('@') && !/resume|curriculum/i.test(firstLine)) {
            name = firstLine;
        }

        const headline = lines.find((line) => /engineer|developer|manager|designer|analyst|consultant|specialist/i.test(line));
        const location = lines.find((line) => /remote|,\s*[A-Z]{2}$|united states|usa|europe|india|canada/i.test(line));
        return { name, email, phone, location, headline };
    }

    private extractExperience(text: string): ExperienceNode[] {
        const sectionLines = this.extractSectionItems(text, ['experience', 'employment', 'work history']);
        const candidates = sectionLines.length > 0
            ? sectionLines
            : text.split('\n').filter((line) => /engineer|developer|manager|analyst|consultant|lead|intern/i.test(line));

        const nodes: ExperienceNode[] = candidates.slice(0, 14).map((line) => {
            const cleaned = line.trim();
            const parts = cleaned.split(/\s[-|@]\s| at /i);
            const title = parts[0]?.trim() || 'Role';
            const organization = parts[1]?.trim() || '';
            const dateMatch = cleaned.match(/(20\d{2}|19\d{2})(?:\s*[-–]\s*(20\d{2}|present|current))?/i);
            return {
                title,
                organization,
                startDate: dateMatch?.[1],
                endDate: dateMatch?.[2],
                text: cleaned,
            };
        }).filter((item) => item.text.length > 8);

        return this.uniqueBy(nodes, (item) => `${item.title}|${item.organization}`).slice(0, 10);
    }

    private extractProjects(text: string): ExperienceNode[] {
        const lines = this.extractSectionItems(text, ['projects', 'project']);
        const projectLines = lines.length > 0
            ? lines
            : text.split('\n').filter((line) => /project|built|developed|launched|implemented/i.test(line));

        const nodes = projectLines.slice(0, 12).map((line) => {
            const trimmed = line.trim();
            return {
                title: trimmed.split(/[:\-]/)[0]?.trim() || 'Project',
                organization: '',
                text: trimmed,
            };
        }).filter((item) => item.text.length > 8);

        return this.uniqueBy(nodes, (item) => item.title).slice(0, 8);
    }

    private extractSectionItems(text: string, headings: string[]): string[] {
        const lines = text.split('\n');
        const start = lines.findIndex((line) => headings.some((h) => line.trim().toLowerCase().includes(h)));
        if (start < 0) return [];

        const items: string[] = [];
        for (const line of lines.slice(start + 1)) {
            const current = line.trim();
            if (!current) continue;
            if (/^[A-Z][A-Z\s]{3,}$/.test(current)) break;
            if (/^[A-Z][a-z]+\s*[A-Z][a-z]+\s*:?$/.test(current) && items.length > 0 && current.length < 28) break;
            items.push(current.replace(/^[-*•]\s*/, ''));
            if (items.length >= 20) break;
        }
        return items;
    }

    private extractSkills(resumeText: string, jdText: string, customContext: string): string[] {
        const full = `${resumeText}\n${jdText}\n${customContext}`.toLowerCase();
        const set = new Set<string>();

        for (const skill of SKILL_KEYWORDS) {
            if (full.includes(skill.toLowerCase())) set.add(skill);
        }

        const explicit = this.extractSectionItems(resumeText, ['skills', 'technical skills', 'core competencies']);
        for (const line of explicit) {
            for (const part of line.split(/[,|/]/).map((p) => p.trim()).filter(Boolean)) {
                if (part.length > 1 && part.length < 40) set.add(part);
            }
        }

        if (set.size < 8) {
            for (const token of this.topKeywords(`${resumeText} ${jdText}`, 20)) set.add(token);
        }

        return Array.from(set).filter((skill) => skill.length > 1).slice(0, 30);
    }

    private extractJobDescription(text: string): PersonaProfile['activeJD'] {
        const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
        const title = lines.find((line) => /engineer|developer|manager|analyst|architect|specialist|consultant|lead/i.test(line)) || lines[0] || 'Target Role';

        const companyMatch = text.match(/company\s*[:\-]\s*([^\n]+)/i)
            || text.match(/at\s+([A-Z][A-Za-z0-9&\-. ]{2,})/)
            || text.match(/([A-Z][A-Za-z0-9&\-. ]{2,})\s+is\s+looking\s+for/i);
        const locationMatch = text.match(/location\s*[:\-]\s*([^\n]+)/i)
            || text.match(/(remote|hybrid|onsite|on-site)/i);

        return {
            title,
            company: companyMatch?.[1]?.trim() || 'Target Company',
            level: this.deriveSeniority(title),
            location: locationMatch?.[1]?.trim(),
            technologies: this.extractSkills('', text, '').slice(0, 14),
            requirements: this.extractSectionItems(text, ['requirements', 'qualifications', 'responsibilities']).slice(0, 14),
            keywords: this.topKeywords(text, 14),
        };
    }

    private estimateExperienceYears(experience: ExperienceNode[], resumeText: string): number {
        const yearsFromNodes = experience.map((node) => {
            const start = Number(node.startDate);
            const endRaw = node.endDate?.toLowerCase();
            const end = endRaw && /^\d{4}$/.test(endRaw) ? Number(endRaw) : new Date().getFullYear();
            if (!Number.isFinite(start) || start < 1980 || start > new Date().getFullYear()) return 0;
            return Math.max(0, end - start);
        }).reduce((acc, years) => acc + years, 0);

        if (yearsFromNodes > 0) return Math.min(40, Math.max(1, yearsFromNodes));

        const years = Array.from(resumeText.matchAll(/(19\d{2}|20\d{2})/g)).map((m) => Number(m[1]));
        if (years.length > 1) {
            const min = Math.min(...years);
            const max = Math.max(...years);
            return Math.min(40, Math.max(1, max - min));
        }

        return 1;
    }

    private deriveSeniority(value: string): string {
        const v = (value || '').toLowerCase();
        if (/staff|principal|director|head|vp|chief|senior|lead|manager/.test(v)) return 'senior';
        if (/intern|junior|associate/.test(v)) return 'junior';
        return 'mid';
    }

    private buildTopStrengths(skills: string[], experience: ExperienceNode[], projects: ExperienceNode[]): string[] {
        const strengths: string[] = [];
        if (skills.length > 0) strengths.push(`Hands-on depth in ${skills.slice(0, 3).join(', ')}`);
        if (experience.length > 0) strengths.push(`Delivered outcomes across ${experience.length} distinct experience nodes`);
        if (projects.length > 0) strengths.push(`Built and shipped ${projects.length} project initiatives`);
        if (strengths.length === 0) strengths.push('Rapid learner with cross-functional collaboration ability');
        return strengths.slice(0, 4);
    }

    private buildCareerSummary(
        identityName: string,
        years: number,
        currentRole: string,
        skills: string[],
        experienceCount: number,
        projectCount: number,
        jd: PersonaProfile['activeJD'],
        customContext: string,
        insights: PersonaProfile['matchInsights'],
    ): string {
        let summary = `${identityName || 'This candidate'} is a ${currentRole} with approximately ${Math.max(1, years)} years of professional experience. `;
        if (skills.length > 0) summary += `Core strengths include ${skills.slice(0, 6).join(', ')}. `;
        summary += `The profile captures ${experienceCount} experience entries and ${projectCount} notable projects.`;

        if (jd) {
            summary += ` For ${jd.title} at ${jd.company}, strongest alignment areas are ${insights.overlapSkills.slice(0, 5).join(', ') || 'problem-solving, execution ownership, and adaptability'}.`;
            if (insights.gapSkills.length) summary += ` Skill gaps to proactively address: ${insights.gapSkills.slice(0, 4).join(', ')}.`;
        }

        if (customContext?.trim()) summary += ' Custom context has been incorporated for persona tuning.';
        return summary;
    }

    private detectSkillSources(skill: string, resumeText: string, jdText: string, customContext: string): string[] {
        const sources: string[] = [];
        const needle = skill.toLowerCase();
        if (resumeText.toLowerCase().includes(needle)) sources.push('resume');
        if (jdText.toLowerCase().includes(needle)) sources.push('job_description');
        if (customContext.toLowerCase().includes(needle)) sources.push('custom_context');
        if (sources.length === 0) sources.push('inferred');
        return sources;
    }

    private storeProfileNodes(profile: PersonaProfile): void {
        const dbHandle = this.db.getDb();
        if (!dbHandle) return;

        this.clearResumeNodes();
        const insert = dbHandle.prepare(`
            INSERT INTO resume_nodes (category, title, organization, start_date, end_date, duration_months, text_content, tags, embedding)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        const putNode = (category: string, title: string, organization: string, text: string, tags: string, startDate?: string | null, endDate?: string | null) => {
            const embedding = this.encodeEmbedding(this.embedText(`${title} ${organization} ${tags} ${text}`));
            const result = insert.run(category, title, organization || '', startDate || null, endDate || null, null, text, tags, embedding);
            const nodeId = Number(result.lastInsertRowid);

            if (this.db.hasVecExtension()) {
                try {
                    dbHandle.prepare(`
                        INSERT INTO vec_resume_nodes_${EMBEDDING_DIM} (node_id, embedding)
                        VALUES (?, ?)
                    `).run(BigInt(nodeId), embedding);
                } catch (e) {
                    console.error('[PersonaEngine] Failed to write native vector embedding:', e);
                }
            }
        };

        const tx = dbHandle.transaction(() => {
            for (const item of profile.experienceTimeline) {
                putNode('experience', item.title, item.organization || '', item.summary, profile.skills.slice(0, 8).join(','), item.startDate, item.endDate);
            }

            for (const project of profile.projectKnowledgeBase) {
                putNode('project', project.title, '', project.summary, project.technologies.join(','));
            }

            for (const edu of profile.education) {
                putNode('education', edu.slice(0, 80), '', edu, 'education');
            }

            for (const cert of profile.certifications) {
                putNode('certification', cert.slice(0, 80), '', cert, 'certification');
            }

            for (const skill of profile.skills) {
                putNode('skill', skill, '', `${skill} competency`, skill);
            }

            if (profile.activeJD) {
                putNode(
                    'job_description',
                    profile.activeJD.title,
                    profile.activeJD.company,
                    `JD Requirements: ${profile.activeJD.requirements.join('; ')}`,
                    profile.activeJD.technologies.join(','),
                );
            }

            if (profile.customContext.trim()) {
                putNode('custom_context', 'Custom Context', '', profile.customContext.trim(), 'custom_context');
            }
        });

        tx();
    }

    private clearResumeNodes(): void {
        const dbHandle = this.db.getDb();
        if (!dbHandle) return;
        try {
            dbHandle.prepare('DELETE FROM resume_nodes').run();
            if (this.db.hasVecExtension()) {
                dbHandle.prepare(`DELETE FROM vec_resume_nodes_${EMBEDDING_DIM}`).run();
            }
        } catch {
            // Ignore in legacy DB states.
        }
    }

    private readJsonState<T>(key: string): T | null {
        const raw = this.db.getAppState(key);
        if (!raw) return null;
        try {
            return JSON.parse(raw) as T;
        } catch {
            return null;
        }
    }

    private getStoredDocumentMeta(key: string): { id?: string; filePath?: string; uploadedAt?: string } | null {
        const doc = this.readJsonState<{ id?: string; filePath?: string; uploadedAt?: string }>(key);
        if (!doc) return null;
        return { id: doc.id, filePath: doc.filePath, uploadedAt: doc.uploadedAt };
    }

    private persistResumeDocument(id: string, filePath: string, content: string, uploadedAt: string): void {
        const dbHandle = this.db.getDb();
        if (!dbHandle) return;
        try {
            dbHandle.prepare(`
                INSERT OR REPLACE INTO resumes (id, file_path, content, parsed_json, uploaded_at)
                VALUES (?, ?, ?, ?, ?)
            `).run(id, filePath, content, JSON.stringify({ textLength: content.length }), uploadedAt);
            this.persistEmbeddings('resume', id, content, { filePath });
        } catch (error) {
            console.warn('[PersonaEngine] Failed to persist resume document:', error);
        }
    }

    private persistJobDescriptionDocument(id: string, filePath: string, content: string, uploadedAt: string): void {
        const dbHandle = this.db.getDb();
        if (!dbHandle) return;
        try {
            dbHandle.prepare(`
                INSERT OR REPLACE INTO job_descriptions (id, file_path, content, parsed_json, uploaded_at)
                VALUES (?, ?, ?, ?, ?)
            `).run(id, filePath, content, JSON.stringify({ textLength: content.length }), uploadedAt);
            this.persistEmbeddings('job_description', id, content, { filePath });
        } catch (error) {
            console.warn('[PersonaEngine] Failed to persist job description:', error);
        }
    }

    private deleteExplicitDocument(tableName: 'resumes' | 'job_descriptions', id: string | null): void {
        const dbHandle = this.db.getDb();
        if (!dbHandle || !id) return;
        const ownerType = tableName === 'resumes' ? 'resume' : 'job_description';
        try {
            dbHandle.prepare(`DELETE FROM ${tableName} WHERE id = ?`).run(id);
            dbHandle.prepare('DELETE FROM embeddings WHERE owner_type = ? AND owner_id = ?').run(ownerType, id);
        } catch (error) {
            console.warn(`[PersonaEngine] Failed to delete ${tableName} document:`, error);
        }
    }

    private persistProfileSnapshot(profile: PersonaProfile): void {
        const dbHandle = this.db.getDb();
        if (!dbHandle) return;
        try {
            dbHandle.prepare(`
                INSERT INTO user_profiles (id, profile_json, compact_summary, created_at, updated_at)
                VALUES ('default', ?, ?, datetime('now'), datetime('now'))
                ON CONFLICT(id) DO UPDATE SET
                    profile_json = excluded.profile_json,
                    compact_summary = excluded.compact_summary,
                    updated_at = excluded.updated_at
            `).run(JSON.stringify(profile), profile.careerSummary);
        } catch (error) {
            console.warn('[PersonaEngine] Failed to persist profile snapshot:', error);
        }
    }

    private persistCompanyDossier(companyName: string, contextHash: string, dossier: CompanyDossier): void {
        const dbHandle = this.db.getDb();
        if (!dbHandle) return;
        try {
            dbHandle.prepare(`
                INSERT INTO company_dossiers (company_name, context_hash, dossier_json, sources_json, created_at, updated_at)
                VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))
            `).run(companyName, contextHash, JSON.stringify(dossier), JSON.stringify(dossier.sources || []));
        } catch (error) {
            console.warn('[PersonaEngine] Failed to persist company dossier:', error);
        }
    }

    private persistEmbeddings(ownerType: string, ownerId: string, content: string, metadata: Record<string, unknown>): void {
        const dbHandle = this.db.getDb();
        if (!dbHandle) return;
        try {
            dbHandle.prepare('DELETE FROM embeddings WHERE owner_type = ? AND owner_id = ?').run(ownerType, ownerId);
            const insert = dbHandle.prepare(`
                INSERT INTO embeddings (owner_type, owner_id, chunk_index, text_content, embedding, metadata_json)
                VALUES (?, ?, ?, ?, ?, ?)
            `);
            const chunks = this.chunkText(content, 1200).slice(0, 80);
            const tx = dbHandle.transaction(() => {
                chunks.forEach((chunk, index) => {
                    insert.run(ownerType, ownerId, index, chunk, this.encodeEmbedding(this.embedText(chunk)), JSON.stringify(metadata));
                });
            });
            tx();
        } catch (error) {
            console.warn('[PersonaEngine] Failed to persist embeddings:', error);
        }
    }

    private chunkText(content: string, maxChars: number): string[] {
        const paragraphs = this.cleanText(content).split(/\n{2,}/).map((part) => part.trim()).filter(Boolean);
        const chunks: string[] = [];
        let current = '';
        for (const paragraph of paragraphs.length ? paragraphs : [content]) {
            if ((current + '\n\n' + paragraph).length > maxChars && current) {
                chunks.push(current);
                current = paragraph;
            } else {
                current = current ? `${current}\n\n${paragraph}` : paragraph;
            }
        }
        if (current) chunks.push(current);
        return chunks.length ? chunks : [content.slice(0, maxChars)];
    }

    private estimateCompRange(years: number, roleTitle: string, location: string): { min: number; max: number; confidence: 'low' | 'medium' | 'high' } {
        const y = Math.max(1, years);
        const seniorityBoost = /staff|principal|director|head|vp|chief/i.test(roleTitle) ? 60000
            : /senior|lead|manager/i.test(roleTitle) ? 35000
            : /intern|junior|associate/i.test(roleTitle) ? -12000
            : 0;
        const geoBoost = /sf|san francisco|bay area|new york|seattle/i.test(location || '') ? 30000 : 0;
        const base = 85000 + y * 9000 + seniorityBoost + geoBoost;
        return {
            min: Math.max(45000, Math.round(base / 5000) * 5000),
            max: Math.max(70000, Math.round((base + 42000) / 5000) * 5000),
            confidence: y >= 6 ? 'medium' : 'low',
        };
    }

    private cleanText(input: string): string {
        return (input || '')
            .replace(/\r\n/g, '\n')
            .replace(/\t/g, ' ')
            .replace(/[ ]{2,}/g, ' ')
            .replace(/\n{3,}/g, '\n\n')
            .trim();
    }

    private topKeywords(text: string, limit: number): string[] {
        const freq = new Map<string, number>();
        for (const token of this.tokenize(text)) {
            if (token.length < 3 || STOP_WORDS.has(token)) continue;
            freq.set(token, (freq.get(token) || 0) + 1);
        }
        return Array.from(freq.entries())
            .sort((a, b) => b[1] - a[1])
            .slice(0, limit)
            .map(([token]) => token);
    }

    private tokenize(text: string): string[] {
        return (text || '')
            .toLowerCase()
            // Unicode-aware: the old [^a-z0-9...] class erased every accented letter,
            // so Vietnamese queries/profiles matched almost nothing.
            .replace(/[^\p{L}\p{N}+.#\-\s]/gu, ' ')
            .split(/\s+/)
            .map((token) => token.trim())
            .filter(Boolean);
    }

    private expandQueryTokens(tokens: string[]): Set<string> {
        const expanded = new Set<string>(tokens);
        for (const token of tokens) {
            const mapped = QUERY_SYNONYMS[token];
            if (!mapped) continue;
            for (const synonym of mapped) {
                for (const normalized of this.tokenize(synonym)) expanded.add(normalized);
            }
        }
        return expanded;
    }

    private embedText(text: string): number[] {
        const vec = new Array<number>(EMBEDDING_DIM).fill(0);
        const tokens = this.tokenize(text).filter((t) => !STOP_WORDS.has(t));
        if (!tokens.length) return vec;

        for (const token of tokens) {
            const hash = crypto.createHash('sha256').update(token).digest();
            const idx = hash.readUInt16BE(0) % EMBEDDING_DIM;
            const sign = (hash[2] & 1) === 0 ? 1 : -1;
            const magnitude = 0.5 + (hash[3] / 255);
            vec[idx] += sign * magnitude;
        }

        const norm = Math.sqrt(vec.reduce((acc, v) => acc + v * v, 0));
        if (norm > 0) {
            for (let i = 0; i < vec.length; i += 1) vec[i] = vec[i] / norm;
        }
        return vec;
    }

    private encodeEmbedding(vector: number[]): Buffer {
        const arr = new Float32Array(vector);
        return Buffer.from(arr.buffer);
    }

    private decodeEmbedding(blob?: Buffer | null): number[] {
        if (!blob || !blob.length) return [];
        const f32 = new Float32Array(blob.buffer, blob.byteOffset, Math.floor(blob.byteLength / 4));
        return Array.from(f32);
    }

    private cosineSimilarity(a: number[], b: number[]): number {
        const len = Math.min(a.length, b.length);
        if (!len) return 0;
        let dot = 0;
        let na = 0;
        let nb = 0;
        for (let i = 0; i < len; i += 1) {
            dot += a[i] * b[i];
            na += a[i] * a[i];
            nb += b[i] * b[i];
        }
        if (!na || !nb) return 0;
        return dot / (Math.sqrt(na) * Math.sqrt(nb));
    }

    private buildSnippet(text: string, query: string): string {
        const normalized = text.replace(/\s+/g, ' ').trim();
        if (!normalized) return '';

        const index = normalized.toLowerCase().indexOf(query.toLowerCase());
        if (index < 0) return normalized.slice(0, 220);

        const start = Math.max(0, index - 90);
        const end = Math.min(normalized.length, index + query.length + 130);
        const prefix = start > 0 ? '...' : '';
        const suffix = end < normalized.length ? '...' : '';
        return `${prefix}${normalized.slice(start, end)}${suffix}`;
    }

    private uniqueBy<T>(items: T[], selector: (item: T) => string): T[] {
        const seen = new Set<string>();
        const out: T[] = [];
        for (const item of items) {
            const key = selector(item).toLowerCase();
            if (!key || seen.has(key)) continue;
            seen.add(key);
            out.push(item);
        }
        return out;
    }

    private hashContext(input: string): string {
        return crypto.createHash('sha256').update(input).digest('hex');
    }

    private getCompanyResearchCache(companyName: string, contextHash: string): CompanyDossier | null {
        const dbHandle = this.db.getDb();
        if (!dbHandle) return null;
        try {
            const row = dbHandle.prepare(`
                SELECT dossier_json, updated_at
                FROM persona_company_research_cache
                WHERE lower(company_name) = lower(?) AND context_hash = ?
                ORDER BY updated_at DESC
                LIMIT 1
            `).get(companyName, contextHash) as { dossier_json: string; updated_at: string } | undefined;
            if (!row) return null;

            const ageMs = Date.now() - new Date(row.updated_at).getTime();
            const maxAgeMs = 6 * 60 * 60 * 1000;
            if (ageMs > maxAgeMs) return null;

            return JSON.parse(row.dossier_json) as CompanyDossier;
        } catch {
            return null;
        }
    }

    private setCompanyResearchCache(companyName: string, contextHash: string, provider: string, dossier: CompanyDossier): void {
        const dbHandle = this.db.getDb();
        if (!dbHandle) return;
        try {
            dbHandle.prepare(`
                INSERT INTO persona_company_research_cache (company_name, context_hash, provider, dossier_json, created_at, updated_at)
                VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))
            `).run(companyName, contextHash, provider, JSON.stringify(dossier));
        } catch {
            // ignore cache write failures
        }
    }

    private persistNegotiationHistory(profile: PersonaProfile, output: NegotiationOutput): void {
        const dbHandle = this.db.getDb();
        if (!dbHandle) return;
        try {
            const inputs = {
                name: profile.identity.name,
                role: profile.activeJD?.title,
                company: profile.activeJD?.company,
                location: profile.activeJD?.location || profile.identity.location || 'US',
                years_experience: profile.totalExperienceYears,
                skills: profile.skills.slice(0, 12),
            };
            dbHandle.prepare(`
                INSERT INTO persona_negotiation_history (company_name, role_title, location, years_experience, inputs_json, output_json, created_at)
                VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
            `).run(
                profile.activeJD?.company || null,
                profile.activeJD?.title || null,
                profile.activeJD?.location || profile.identity.location || null,
                profile.totalExperienceYears,
                JSON.stringify(inputs),
                JSON.stringify(output),
            );
            dbHandle.prepare(`
                INSERT INTO salary_reports (company_name, role_title, location, inputs_json, report_json, created_at)
                VALUES (?, ?, ?, ?, ?, datetime('now'))
            `).run(
                profile.activeJD?.company || null,
                profile.activeJD?.title || null,
                profile.activeJD?.location || profile.identity.location || null,
                JSON.stringify(inputs),
                JSON.stringify(output),
            );
        } catch {
            // non-fatal persistence path
        }
    }

    public detectLanguage(text: string): 'Vietnamese' | 'English' {
        if (!text) return 'English';
        const vnDiacritics = /[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/i;
        if (vnDiacritics.test(text)) return 'Vietnamese';

        const vnWords = /\b(và|của|cho|với|trong|được|có|là|người|tôi|chúng|tại|không|đây|này|nào|nơi|khi|như|những|một|hai|ba|bốn|năm|sáu|bảy|tám|chín|mười)\b/i;
        if (vnWords.test(text)) return 'Vietnamese';

        return 'English';
    }

    private getTargetLanguageFromInputs(): 'Vietnamese' | 'English' {
        const customContext = this.db.getCustomNotes();
        if (this.detectLanguage(customContext) === 'Vietnamese') return 'Vietnamese';

        const resumeRaw = this.db.getAppState(APP_STATE_KEYS.resume);
        if (resumeRaw) {
            try {
                const parsed = JSON.parse(resumeRaw);
                if (this.detectLanguage(parsed.content || '') === 'Vietnamese') return 'Vietnamese';
            } catch {}
        }

        const jdRaw = this.db.getAppState(APP_STATE_KEYS.jd);
        if (jdRaw) {
            try {
                const parsed = JSON.parse(jdRaw);
                if (this.detectLanguage(parsed.content || '') === 'Vietnamese') return 'Vietnamese';
            } catch {}
        }

        return 'English';
    }

    private async translateProfileToVietnamese(profile: PersonaProfile): Promise<PersonaProfile> {
        if (!this.llmHelper) return profile;
        try {
            const prompt = `You are a professional translator. Translate the following JSON object representing a career profile into Vietnamese. Keep the keys and structure exactly the same. Translate values such as currentRole, headline, domainFocus, topStrengths, skills, summary, technologies, certifications, careerSummary, and matchInsights (overlapSkills, gapSkills, interviewPreparation, personalizedCareerAdvice) into natural, professional Vietnamese. Keep standard industry terms (like Kubernetes, Python, React, DevOps) in English.

JSON to translate:
${JSON.stringify(profile, null, 2)}`;
            const response = await this.llmHelper.chatWithGemini(prompt, undefined, undefined, true, undefined, true);
            const match = response.match(/\{[\s\S]*\}/);
            if (match) {
                const parsed = JSON.parse(match[0]);
                return { ...profile, ...parsed };
            }
        } catch (e) {
            console.error('[PersonaEngine] Failed to translate profile to Vietnamese:', e);
        }
        return profile;
    }

    private async translateDossierToVietnamese(dossier: CompanyDossier): Promise<CompanyDossier> {
        if (!this.llmHelper) return dossier;
        try {
            const prompt = `You are a professional translator. Translate the following JSON object representing a company research dossier into Vietnamese. Keep the keys and structure exactly the same. Translate values such as summary, productsAndServices, financialStatus, engineeringCulture, interviewTips, and roleAlignment (pros, cons, overallFit) into natural, professional Vietnamese. Keep standard technical terms (like AWS, React, etc.) unchanged.

JSON to translate:
${JSON.stringify(dossier, null, 2)}`;
            const response = await this.llmHelper.chatWithGemini(prompt, undefined, undefined, true, undefined, true);
            const match = response.match(/\{[\s\S]*\}/);
            if (match) {
                const parsed = JSON.parse(match[0]);
                return { ...dossier, ...parsed };
            }
        } catch (e) {
            console.error('[PersonaEngine] Failed to translate dossier to Vietnamese:', e);
        }
        return dossier;
    }

    private async translateScriptToVietnamese(script: NegotiationOutput): Promise<NegotiationOutput> {
        if (!this.llmHelper) return script;
        try {
            const prompt = `You are a professional translator. Translate the following JSON object representing a career negotiation script/strategy into Vietnamese. Keep the keys and structure exactly the same. Translate values such as negotiation_strategy, strengths_to_emphasize, compensation_risk_analysis, offer_comparison_framework, counter_offer_suggestions, negotiation_scripts (opening, anchoring, pushback_response, close), recruiter_response_drafts (initial_reply, follow_up, final_acceptance_if_aligned), offer_evaluation_report, opening_line, justification, and counter_offer_fallback into natural, professional Vietnamese. Keep monetary units like USD or any specific numbers unchanged.

JSON to translate:
${JSON.stringify(script, null, 2)}`;
            const response = await this.llmHelper.chatWithGemini(prompt, undefined, undefined, true, undefined, true);
            const match = response.match(/\{[\s\S]*\}/);
            if (match) {
                const parsed = JSON.parse(match[0]);
                return { ...script, ...parsed };
            }
        } catch (e) {
            console.error('[PersonaEngine] Failed to translate negotiation script to Vietnamese:', e);
        }
        return script;
    }
}
