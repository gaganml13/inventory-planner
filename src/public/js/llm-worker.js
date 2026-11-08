/**
 * llm-worker.js — Open-Source In-Browser Neural LLM Web Worker
 *
 * Uses Hugging Face @huggingface/transformers inside a dedicated non-blocking Web Worker.
 * Caches model weights permanently in browser IndexedDB (0 tokens, 100% free, 0 backend RAM).
 * Provides streaming/status updates and falls back seamlessly to grounded SQLite facts.
 */

/* global self, importScripts */

// Configuration
const DEFAULT_MODEL = 'Xenova/Qwen1.5-0.5B-Chat'; // or HuggingFaceTB/SmolLM2-135M-Instruct
let generator = null;
let isInitializing = false;

async function getGenerator(progressCallback) {
  if (generator) return generator;
  if (isInitializing) {
    // Wait for in-flight initialization
    while (isInitializing && !generator) {
      await new Promise((r) => setTimeout(r, 200));
    }
    if (generator) return generator;
  }

  isInitializing = true;
  try {
    const { pipeline, env } = await import('https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.3.3');

    // Force browser cache (IndexedDB) and disable local model check
    env.allowLocalModels = false;
    env.useBrowserCache = true;

    self.postMessage({
      type: 'status',
      status: 'downloading',
      message: 'Loading analytical reasoning model weights...'
    });

    generator = await pipeline('text-generation', DEFAULT_MODEL, {
      dtype: 'q4',
      device: 'wasm',
      progress_callback: (p) => {
        if (progressCallback) progressCallback(p);
        self.postMessage({
          type: 'progress',
          data: p
        });
      }
    });

    self.postMessage({
      type: 'status',
      status: 'ready',
      message: 'Smart Reasoning Engine ready in browser memory.'
    });

    return generator;
  } catch (err) {
    console.warn('[LLM-Worker] Initialization warning (falling back to Real-Time Ledger):', err);
    self.postMessage({
      type: 'status',
      status: 'fallback',
      error: err.message
    });
    throw err;
  } finally {
    isInitializing = false;
  }
}

self.onmessage = async (e) => {
  const { type, id, question, liveContext, groundedAnswer } = e.data || {};

  if (type === 'init') {
    try {
      await getGenerator();
    } catch (_) {
      // Status message posted
    }
    return;
  }

  if (type === 'generate') {
    try {
      // 1. Ensure model is loaded
      let gen;
      try {
        gen = await getGenerator();
      } catch (loadErr) {
        // If loading weights fails (e.g. offline or low memory), return grounded answer directly
        self.postMessage({
          type: 'result',
          id,
          answer: groundedAnswer,
          model: '⚡ Real-Time Ledger',
          fallback: true
        });
        return;
      }

      self.postMessage({
        type: 'status',
        status: 'generating',
        id
      });

      // 2. Construct grounded prompt with Live SQLite Context
      const prompt = [
        `<|im_start|>system`,
        `You are Smart Copilot, an expert wholesale operations and inventory analyst for Smart Business Analyzer.`,
        `Answer the user's question concisely based strictly on the factual business context and verified calculations below. Do not make up numbers.`,
        `Live Business Context: ${JSON.stringify(liveContext || {})}`,
        `Verified Grounded Data:`,
        `${groundedAnswer || 'No specific figures.'}`,
        `<|im_end|>`,
        `<|im_start|>user`,
        `${question}`,
        `<|im_end|>`,
        `<|im_start|>assistant\n`
      ].join('\n');

      const output = await gen(prompt, {
        max_new_tokens: 280,
        temperature: 0.2,
        do_sample: false,
        return_full_text: false
      });

      let generatedText = '';
      if (Array.isArray(output) && output[0]?.generated_text) {
        generatedText = output[0].generated_text.trim();
      } else if (typeof output === 'string') {
        generatedText = output.trim();
      }

      // If output is too short or empty, provide groundedAnswer
      const finalAnswer = generatedText && generatedText.length > 20 ? generatedText : groundedAnswer;

      self.postMessage({
        type: 'result',
        id,
        answer: finalAnswer,
        model: '🧠 Smart Reasoning'
      });
    } catch (genErr) {
      console.warn('[LLM-Worker] Generation error, using grounded answer:', genErr);
      self.postMessage({
        type: 'result',
        id,
        answer: groundedAnswer,
        model: '⚡ Real-Time Ledger',
        fallback: true
      });
    }
  }
};
