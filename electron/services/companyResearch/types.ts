export type CompanyResearchContext = {
    companyName: string;
    jobTitle?: string;
    location?: string;
    yearsExperience?: number;
    technologies?: string[];
    requirements?: string[];
    customContext?: string;
};

export type CompanyResearchEvidence = {
    title: string;
    url?: string;
    snippet: string;
    source: string;
    publishedAt?: string;
    score?: number;
};

export type CompanyDossier = {
    company_overview: string;
    products_and_services: string[];
    business_model: string;
    competitors: string[];
    recent_news: string[];
    hiring_trends: string;
    interview_insights: string;
    company_culture_summary: string;
    interview_focus: string;
    interview_difficulty: 'easy' | 'medium' | 'hard' | 'very_hard';
    salary_estimates: Array<{
        title: string;
        location: string;
        min: number;
        max: number;
        currency: string;
        confidence: 'low' | 'medium' | 'high';
    }>;
    sources: string[];
    evidence: CompanyResearchEvidence[];
    generatedAt: string;
};

export type CompanyResearchProvider = {
    name: string;
    research(context: CompanyResearchContext): Promise<CompanyDossier>;
};
