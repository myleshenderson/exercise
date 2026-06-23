import type { Exercise, WorkoutDay, Session } from "../types";

export const seedExercises: Exercise[] = [
  { id: "leg-press", name: "Leg Press", cue: "main driver", defaultSets: 3, defaultRepLow: 10, defaultRepHigh: 12 },
  { id: "leg-curl", name: "Leg Curl", cue: "hamstrings — cycling neglects these", defaultSets: 3, defaultRepLow: 10, defaultRepHigh: 15 },
  { id: "leg-extension", name: "Leg Extension", cue: "quads, full range", defaultSets: 3, defaultRepLow: 12, defaultRepHigh: 15 },
  { id: "seated-calf-raise", name: "Seated Calf Raise", cue: "", defaultSets: 3, defaultRepLow: 12, defaultRepHigh: 20 },
  { id: "hip-thrust", name: "Hip Thrust or Back Extension", cue: "glutes/posterior chain", defaultSets: 3, defaultRepLow: 10, defaultRepHigh: 15 },
  { id: "core-crunch", name: "Core / Machine Crunch", cue: "hanging or machine", defaultSets: 3, defaultRepLow: 12, defaultRepHigh: 15 },
  { id: "chest-press", name: "Chest Press", cue: "", defaultSets: 4, defaultRepLow: 8, defaultRepHigh: 12 },
  { id: "seated-row", name: "Seated Row", cue: "squeeze shoulder blades", defaultSets: 4, defaultRepLow: 10, defaultRepHigh: 12 },
  { id: "shoulder-press", name: "Shoulder Press", cue: "", defaultSets: 3, defaultRepLow: 8, defaultRepHigh: 12 },
  { id: "lat-pulldown", name: "Lat Pulldown", cue: "drive elbows down", defaultSets: 3, defaultRepLow: 10, defaultRepHigh: 12 },
  { id: "lateral-raise", name: "Lateral Raise", cue: "light, controlled", defaultSets: 3, defaultRepLow: 12, defaultRepHigh: 15 },
  { id: "triceps-pushdown", name: "Triceps Pushdown", cue: "", defaultSets: 3, defaultRepLow: 10, defaultRepHigh: 15 },
  { id: "bicep-curl", name: "Bicep Curl", cue: "", defaultSets: 3, defaultRepLow: 10, defaultRepHigh: 12 },
  { id: "pectoral-fly", name: "Pectoral Fly", cue: "", defaultSets: 3, defaultRepLow: 10, defaultRepHigh: 12 },
];

export const seedDays: WorkoutDay[] = [
  {
    id: "leg-day", name: "Leg Day", position: 0,
    exerciseIds: ["leg-press", "leg-curl", "leg-extension", "seated-calf-raise", "hip-thrust", "core-crunch"],
  },
  {
    id: "upper-day", name: "Upper Day", position: 1,
    exerciseIds: ["chest-press", "seated-row", "shoulder-press", "lat-pulldown", "lateral-raise", "triceps-pushdown"],
  },
];

// One prior session per day so "last time" has data to show.
export const seedSessions: Session[] = [
  {
    id: "seed-leg", workoutDayId: "leg-day", performedOn: "2026-06-18",
    exercises: [
      { exerciseId: "leg-press", sets: [{ setNumber: 1, weight: 150, reps: 12 }, { setNumber: 2, weight: 150, reps: 12 }, { setNumber: 3, weight: 150, reps: 12 }] },
      { exerciseId: "leg-curl", sets: [{ setNumber: 1, weight: 105, reps: 10 }, { setNumber: 2, weight: 105, reps: 10 }, { setNumber: 3, weight: 105, reps: 10 }] },
      { exerciseId: "leg-extension", sets: [{ setNumber: 1, weight: 110, reps: 12 }, { setNumber: 2, weight: 110, reps: 12 }, { setNumber: 3, weight: 110, reps: 12 }] },
      { exerciseId: "seated-calf-raise", sets: [{ setNumber: 1, weight: 55, reps: 15 }, { setNumber: 2, weight: 55, reps: 15 }, { setNumber: 3, weight: 55, reps: 15 }] },
      { exerciseId: "hip-thrust", sets: [{ setNumber: 1, weight: 90, reps: 12 }, { setNumber: 2, weight: 90, reps: 12 }, { setNumber: 3, weight: 90, reps: 12 }] },
      { exerciseId: "core-crunch", sets: [{ setNumber: 1, weight: 105, reps: 12 }, { setNumber: 2, weight: 105, reps: 12 }, { setNumber: 3, weight: 105, reps: 12 }] },
    ],
  },
  {
    id: "seed-upper", workoutDayId: "upper-day", performedOn: "2026-06-20",
    exercises: [
      { exerciseId: "chest-press", sets: [{ setNumber: 1, weight: 70, reps: 12 }, { setNumber: 2, weight: 70, reps: 12 }, { setNumber: 3, weight: 70, reps: 12 }, { setNumber: 4, weight: 70, reps: 12 }] },
      { exerciseId: "seated-row", sets: [{ setNumber: 1, weight: 75, reps: 10 }, { setNumber: 2, weight: 75, reps: 10 }, { setNumber: 3, weight: 75, reps: 10 }, { setNumber: 4, weight: 75, reps: 10 }] },
      { exerciseId: "shoulder-press", sets: [{ setNumber: 1, weight: 25, reps: 10 }, { setNumber: 2, weight: 25, reps: 10 }, { setNumber: 3, weight: 25, reps: 8 }] },
      { exerciseId: "lat-pulldown", sets: [{ setNumber: 1, weight: 85, reps: 10 }, { setNumber: 2, weight: 85, reps: 10 }, { setNumber: 3, weight: 85, reps: 10 }] },
    ],
  },
];
