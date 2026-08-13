const reverseBits = (value: number, bitCount: number) => {
  let result = 0;
  for (let bit = 0; bit < bitCount; bit += 1) {
    result = (result << 1) | ((value >>> bit) & 1);
  }
  return result;
};

export function realFftMagnitudes(input: Float32Array): Float32Array {
  const size = input.length;
  const bitCount = Math.log2(size);
  if (!Number.isInteger(bitCount)) {
    throw new Error("FFT input length must be a power of two");
  }

  const real = new Float64Array(size);
  const imaginary = new Float64Array(size);
  for (let index = 0; index < size; index += 1) {
    real[reverseBits(index, bitCount)] = input[index];
  }

  for (let width = 2; width <= size; width *= 2) {
    const half = width / 2;
    const angleStep = (-2 * Math.PI) / width;
    for (let start = 0; start < size; start += width) {
      for (let offset = 0; offset < half; offset += 1) {
        const angle = angleStep * offset;
        const cos = Math.cos(angle);
        const sin = Math.sin(angle);
        const evenIndex = start + offset;
        const oddIndex = evenIndex + half;
        const oddReal = real[oddIndex] * cos - imaginary[oddIndex] * sin;
        const oddImaginary = real[oddIndex] * sin + imaginary[oddIndex] * cos;
        const evenReal = real[evenIndex];
        const evenImaginary = imaginary[evenIndex];
        real[evenIndex] = evenReal + oddReal;
        imaginary[evenIndex] = evenImaginary + oddImaginary;
        real[oddIndex] = evenReal - oddReal;
        imaginary[oddIndex] = evenImaginary - oddImaginary;
      }
    }
  }

  const magnitudes = new Float32Array(size / 2);
  const scale = 2 / size;
  for (let index = 0; index < magnitudes.length; index += 1) {
    magnitudes[index] = Math.hypot(real[index], imaginary[index]) * scale;
  }
  return magnitudes;
}
