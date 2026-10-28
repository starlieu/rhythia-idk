using Godot;

/// <summary>
/// Mobile-friendly pause overlay.
/// - Listens for the Android "Back" button to pause/resume on mobile.
/// - Exposes touch-friendly handlers for Resume / Pause / Speed +/- / Record
///   buttons to wire up in the UI scene.
/// </summary>
public partial class MobilePauseOverlay : CanvasLayer
{
    private ReplaySpeedControl _speed;

    public override void _Ready()
    {
        _speed = GetNode<ReplaySpeedControl>("/root/ReplaySpeedControl");
    }

    public override void _UnhandledInput(InputEvent @event)
    {
        // Android back button maps to ui_cancel; use it to pause/resume on mobile.
        if (@event.IsActionPressed("ui_cancel") && OS.HasFeature("android"))
        {
            _speed?.TogglePause();
            GetViewport().SetInputAsHandled();
        }
    }

    public void OnResumePressed() => _speed?.SetPaused(false);
    public void OnPausePressed() => _speed?.SetPaused(true);
    public void OnSpeedUpPressed() => _speed?.SpeedUp();
    public void OnSpeedDownPressed() => _speed?.SpeedDown();

    public void OnRecordPressed()
    {
        var exporter = GetNode<VideoExporter>("/root/VideoExporter");
        if (exporter.IsRecording)
            exporter.StopRecording();
        else
            exporter.StartRecording();
    }
}
