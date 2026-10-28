using System;
using System.IO;
using Godot;

/// <summary>
/// Lightweight video export: captures the viewport to a folder of numbered
/// PNG frames while the game runs, so it can be re-encoded into a video
/// (e.g. with ffmpeg -framerate 60 -i frame_%06d.png out.mp4).
/// Intended for replays and highlight clips; runs on desktop and mobile.
/// </summary>
public partial class VideoExporter : Node
{
    public static VideoExporter Instance { get; private set; }

    private bool _recording;
    private int _frame;
    private string _dir;

    public bool IsRecording => _recording;

    public event Action RecordingStarted;
    public event Action<string> RecordingStopped; // output dir

    public override void _Ready()
    {
        Instance = this;
        SetProcess(false);
    }

    /// <summary>Start capturing frames to a new folder under user://videos.</summary>
    public void StartRecording(string clipName = null)
    {
        if (_recording)
            return;

        clipName ??= DateTime.Now.ToString("yyyy-MM-dd_HH-mm-ss");
        _dir = Path.Combine(OS.GetUserDataDir(), "videos", clipName);
        Directory.CreateDirectory(_dir);

        _frame = 0;
        _recording = true;
        SetProcess(true);
        RecordingStarted?.Invoke();
        GD.Print($"[VideoExporter] Recording to {_dir}");
    }

    public void StopRecording()
    {
        if (!_recording)
            return;

        _recording = false;
        SetProcess(false);
        RecordingStopped?.Invoke(_dir);
        GD.Print($"[VideoExporter] Stopped after {_frame} frames in {_dir}");
    }

    public override void _Process(double delta)
    {
        CaptureFrame();
    }

    private void CaptureFrame()
    {
        var tex = GetViewport().GetTexture();
        if (tex == null)
            return;

        var img = tex.GetImage();
        if (img == null)
            return;

        img.SavePng(Path.Combine(_dir, $"frame_{_frame:D6}.png"));
        _frame++;
    }
}
