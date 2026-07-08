import { ImageProcessingProcessor } from '../processors/image-processing.processor';
import type { ImageProcessorService } from '../services/image-processor.service';

describe('ImageProcessingProcessor', () => {
  const buildProcessor = (
    impl: jest.Mock = jest.fn(async (id: string) => ({
      mediaId: id,
      variants: {} as never,
      totalSizeBytes: 1,
      optimizationRatio: 1,
      durationMs: 1,
    })),
  ): {
    processor: ImageProcessingProcessor;
    spy: jest.Mock;
  } => {
    const inner = { processImage: impl } as unknown as ImageProcessorService;
    return { processor: new ImageProcessingProcessor(inner), spy: impl };
  };

  it('enqueue delegates to ImageProcessorService.processImage', async () => {
    const { processor, spy } = buildProcessor();
    const result = await processor.enqueue('m-1');
    expect(result.mediaId).toBe('m-1');
    expect(spy).toHaveBeenCalledWith('m-1');
  });

  it('handleProcess delegates with the same payload shape', async () => {
    const { processor, spy } = buildProcessor();
    const result = await processor.handleProcess({ mediaId: 'm-2' });
    expect(result.mediaId).toBe('m-2');
    expect(spy).toHaveBeenCalledWith('m-2');
  });

  it('propagates errors from the inner processor', async () => {
    const { processor } = buildProcessor(
      jest.fn(async () => {
        throw new Error('boom');
      }),
    );
    await expect(processor.enqueue('m-3')).rejects.toThrow('boom');
  });
});
