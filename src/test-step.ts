import { Workflow, createStep } from '@mastra/core/workflows';
import { z } from 'zod';

const step1 = createStep({
    id: 'step1',
    inputSchema: z.object({ value: z.string() }),
    outputSchema: z.object({ done: z.boolean() }),
    execute: async ({ inputData }) => {
        console.log(inputData.value);
        return { done: true };
    }
});
