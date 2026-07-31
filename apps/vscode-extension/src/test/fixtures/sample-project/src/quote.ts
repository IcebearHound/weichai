export interface QuoteRequest {
  pair: string;
  maxAgeSeconds: number;
}

export class QuoteService {
  async getQuote(request: QuoteRequest): Promise<string> {
    return `quote:${request.pair}`;
  }
}
