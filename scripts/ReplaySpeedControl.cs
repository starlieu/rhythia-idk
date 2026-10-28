using System;
using Godot;

/// <summary>
/// Replay speed control: changes game playback speed (0.25x to 2x),
/// plus global pause. Works on both desktop and mobile builds.
/// Toggled from the pause overlay or the +/- buttons in the replay UI.
/// </summary>
public partial class ReplaySpeedControl : Node
{
    private static readonly float[] Speeds = { 0.25f, 0.5f, 0.75f, 1.0f, 1.25f, 1.5f, 2.0f };

    private int _index = 3; // 1.0x
    private bool _paused;

    public float CurrentSpeed => Speeds[_index];
    public bool IsPaused => _paused;

    public event Action<float> SpeedChanged;
    public event Action<bool> PauseChanged;

    public override void _Ready()
    {
        Engine.TimeScale = 1.0f;
    }

    public override void _UnhandledInput(InputEvent @event)
    {
        if (@event is InputEventKey { Pressed: true, Echo: false } key)
        {
            if (key.PhysicalKeycode == Key.Plus || key.PhysicalKeycode == Key.KpAdd)
                SpeedUp();
            else if (key.PhysicalKeycode == Key.Minus || key.PhysicalKeycode == Key.KpSubtract)
                SpeedDown();
        }
    }

    public void SpeedUp()
    {
        if (_index < Speeds.Length - 1)
            SetSpeed(_index + 1);
    }

    public void SpeedDown()
    {
        if (_index > 0)
            SetSpeed(_index - 1);
    }

    public void SetSpeedByIndex(int index)
    {
        if (index >= 0 && index < Speeds.Length)
            SetSpeed(index);
    }

    public void ResetSpeed() => SetSpeed(3);

    private void SetSpeed(int index)
    {
        _index = index;
        if (!_paused)
            Engine.TimeScale = Speeds[_index];
        SpeedChanged?.Invoke(Speeds[_index]);
    }

    public void TogglePause() => SetPaused(!_paused);

    public void SetPaused(bool paused)
    {
        _paused = paused;
        Engine.TimeScale = paused ? 0.0f : Speeds[_index];
        GetTree().Paused = paused;
        PauseChanged?.Invoke(paused);
    }
}
