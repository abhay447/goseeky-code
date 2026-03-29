// src/search/bm25Store.ts

type Doc = {
    id: string;
    text: string;
};

export class KWStore {
    // implements bm25
    private docs: Doc[] = [];
    private docFreq = new Map<string, number>(); // term → doc count
    private termFreqs: Map<string, number>[] = []; // per-doc term freq
    private avgDocLength = 0;

    private k1 = 1.2;
    private b = 0.75;

    // -----------------------------
    // Add documents
    // -----------------------------
    add(doc: Doc) {
        const tokens = tokenize(doc.text);

        const tf = new Map<string, number>();

        tokens.forEach(t => {
            tf.set(t, (tf.get(t) || 0) + 1);
        });

        this.termFreqs.push(tf);
        this.docs.push(doc);

        // update doc freq
        const uniqueTokens = new Set(tokens);
        uniqueTokens.forEach(t => {
            this.docFreq.set(t, (this.docFreq.get(t) || 0) + 1);
        });
    }

    finalize() {
        const totalLength = this.termFreqs.reduce(
            (sum, tf) => sum + Array.from(tf.values()).reduce((a, b) => a + b, 0),
            0
        );

        this.avgDocLength = totalLength / this.docs.length;
    }

    // -----------------------------
    // Search
    // -----------------------------
    search(query: string, topK = 10) {
        const tokens = tokenize(query);

        const scores: number[] = new Array(this.docs.length).fill(0);

        tokens.forEach(term => {
            const df = this.docFreq.get(term) || 0;
            if (df === 0) return;

            const idf = Math.log(
                (this.docs.length - df + 0.5) / (df + 0.5) + 1
            );

            this.termFreqs.forEach((tf, i) => {
                const freq = tf.get(term) || 0;
                if (freq === 0) return;

                const docLength = Array.from(tf.values()).reduce((a, b) => a + b, 0);

                const score =
                    idf *
                    ((freq * (this.k1 + 1)) /
                        (freq +
                            this.k1 *
                            (1 - this.b + (this.b * docLength) / this.avgDocLength)));

                scores[i] += score;
            });
        });

        return this.docs
            .map((doc, i) => ({
                id: doc.id,
                score: scores[i],
            }))
            .sort((a, b) => b.score - a.score)
            .slice(0, topK);
    }

}

export function tokenize(text: string): string[] {
    return text
        .replace(/([a-z])([A-Z])/g, "$1 $2") // camelCase
        .replace(/[^a-zA-Z0-9_]/g, " ")
        .toLowerCase()
        .split(/\s+/)
        .filter(Boolean);
}