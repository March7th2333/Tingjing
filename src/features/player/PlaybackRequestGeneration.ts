export class PlaybackRequestGeneration {
  private audioGeneration = 0;
  private lyricsGeneration = 0;

  beginAudio() {
    this.audioGeneration += 1;
    return this.audioGeneration;
  }

  beginLyrics() {
    this.lyricsGeneration += 1;
    return this.lyricsGeneration;
  }

  isCurrentAudio(generation: number) {
    return generation === this.audioGeneration;
  }

  isCurrentLyrics(generation: number) {
    return generation === this.lyricsGeneration;
  }

  invalidateAll() {
    this.audioGeneration += 1;
    this.lyricsGeneration += 1;
  }
}
