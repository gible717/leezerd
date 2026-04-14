declare module 'sound-play' {
    const sound: {
        play(filePath: string, volume?: number): Promise<void>;
    };
    export default sound;
}
