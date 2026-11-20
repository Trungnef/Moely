import { PersonaEngine } from '../../services/PersonaEngine';
import { DatabaseManager } from '../../db/DatabaseManager';

export class CareerIntelligenceEngine {
    private static instance: CareerIntelligenceEngine;
    private persona = PersonaEngine.getInstance();

    public static getInstance(): CareerIntelligenceEngine {
        if (!CareerIntelligenceEngine.instance) {
            CareerIntelligenceEngine.instance = new CareerIntelligenceEngine();
        }
        return CareerIntelligenceEngine.instance;
    }

    public setLLMHelper(llmHelper: any) {
        this.persona.setLLMHelper(llmHelper);
    }

    public async uploadResume(filePath: string) {
        const result = await this.persona.ingestResume(filePath);
        return { ...result, state: this.persona.getCareerState() };
    }

    public async uploadJobDescription(filePath: string) {
        const result = await this.persona.ingestJobDescription(filePath);
        return { ...result, state: this.persona.getCareerState() };
    }

    public async researchCompany(companyName: string) {
        return this.persona.researchCompany(companyName);
    }

    public async analyzeSalary(force: boolean = false) {
        const result = await this.persona.generateNegotiationScript(force);
        return result.success ? { success: true, report: result.script, script: result.script } : result;
    }

    public queryContext(query: string, limit: number = 8) {
        return this.persona.queryContext(query, limit);
    }

    public getProfileState() {
        return this.persona.getCareerState();
    }

    public setMode(enabled: boolean) {
        const result = this.persona.setMode(enabled);
        return { ...result, state: this.persona.getCareerState() };
    }

    public async deleteResume() {
        const result = await this.persona.deleteResume();
        return { ...result, state: this.persona.getCareerState() };
    }

    public async deleteJobDescription() {
        const result = await this.persona.deleteJobDescription();
        return { ...result, state: this.persona.getCareerState() };
    }

    public getProfileData() {
        return this.persona.getProfileData();
    }

    public getNotes() {
        const content = DatabaseManager.getInstance().getCustomNotes();
        // Keep both names for backward compatibility: older UI builds read
        // `content`, some internal callers/tests used `notes`.
        return { success: true, content, notes: content };
    }

    public async saveNotes(content: string) {
        DatabaseManager.getInstance().saveCustomNotes(content);
        await this.persona.refreshProfileFromStored();
        return { success: true, content, notes: content, state: this.persona.getCareerState() };
    }

    public semanticSearch(query: string, limit: number = 8) {
        return this.persona.semanticSearch(query, limit);
    }

    public getNegotiationState() {
        return this.persona.getNegotiationState();
    }

    public resetNegotiation() {
        const result = this.persona.resetNegotiation();
        return { ...result, state: this.persona.getCareerState() };
    }
}
