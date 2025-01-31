import {
	convertSyllabusTreeToMarkdown,
	pick,
} from "ducs-lib/dist/campussquare-syllabus/tree"
import * as googleapis from "googleapis"
import {
	DEFAULT_DUMP_DIRECTORY,
	parsingProgressBar,
	readAndParseDumpedSyllabus,
	schoolYear,
} from "./internal"

// env
const loadEnv = () => {
	type Env = {
		CLIENT_ID: string
		CLIENT_SECRET: string
	}
	const keys = ["CLIENT_ID", "CLIENT_SECRET"] as const
	return keys.reduce((acc, k) => {
		const t = process.env[k]
		if (!t) throw new Error(`Missing environment variable: ${k}`)
		acc[k] = t
		return acc
	}, {} as Env)
}
const { CLIENT_ID, CLIENT_SECRET } = loadEnv()

const question = (question: string) =>
	new Promise<string>((res, rej) => {
		process.stdout.write(question)
		if (!process.stdin.readable) return rej("not readable.")
		let all: string = ""
		while (process.stdin.read()) {
			process.stdin.readable
		}
		const onData = (chunk: Buffer) => {
			all += chunk
			if (all.includes("\n")) {
				onEnd()
			}
		}
		const onEnd = () => {
			process.stdin.removeListener("data", onData)
			process.stdin.removeListener("end", onEnd)
			res(all.trim())
		}
		process.stdin.on("data", onData)
		process.stdin.on("end", onEnd)
	})

const CODE_PATH = [
	["講義概要/Course Information", "科目基礎情報/General Information"],
	"科目番号/Code",
] as [[string, string], string]

// どこかに知識を移譲したい。また、長期休みを考慮していない
const SCHEDULE = {
	"2020": {
		前学期: {
			start: [2020, 5, 7],
			end: [2020, 9, 8],
		},
		後学期: {
			start: [2020, 10, 1],
			end: [2021, 2, 18],
		},
	},
	"2021": {
		前学期: {
			start: [2021, 4, 8],
			end: [2021, 8, 26],
		},
		後学期: {
			start: [2021, 10, 1],
			end: [2022, 2, 18],
		},
	},
} as const

const calcReccurence = (y: keyof typeof SCHEDULE, g: "前学期" | "後学期") => {
	// ref(Date-Time type): https://tools.ietf.org/html/rfc5545#section-3.3.5
	// 終了日の 23:59:59 にする
	const recEveryWeekToYMD = (y: number, m: number, d: number) =>
		`RRULE:FREQ=DAILY;INTERVAL=7;UNTIL=${y}${m
			.toString(10)
			.padStart(2, "0")}${d.toString(10).padStart(2, "0")}T145959Z`
	const end = SCHEDULE[y][g].end
	return recEveryWeekToYMD(end[0], end[1], end[2])
}

type Time = {
	hours: number
	minutes: number
}
type Cal = {
	start: Time
	end: Time
	dayOfWeek: number
	reccurence: string
}
const calculateCalendarFromJigen = (j: string[], reccurence: string): Cal => {
	// JavaScript の day of week
	const dayOfWeek = ["日", "月", "火", "水", "木", "金", "土"]
	const fromTimeString = (s: string): Time => {
		const times = s.split(":").map((p) => Number.parseInt(p))
		if (times.length !== 2 || times.some((v) => Number.isNaN(v)))
			throw new Error()
		const [hours, minutes] = times
		return { hours, minutes }
	}
	const timeSchedule = {
		"1": {
			start: fromTimeString("9:00"),
			end: fromTimeString("10:30"),
		},
		"2": {
			start: fromTimeString("10:40"),
			end: fromTimeString("12:10"),
		},
		"3": {
			start: fromTimeString("13:00"),
			end: fromTimeString("14:30"),
		},
		"4": {
			start: fromTimeString("14:40"),
			end: fromTimeString("16:10"),
		},
		"5": {
			start: fromTimeString("16:15"),
			end: fromTimeString("17:45"),
		},
		"6": {
			start: fromTimeString("17:50"),
			end: fromTimeString("19:20"),
		},
		"7": {
			start: fromTimeString("19:30"),
			end: fromTimeString("21:00"),
		},
	} as Record<string, { start: Time; end: Time }>
	const schedule = j
		.map((jikanwari: string) => {
			// 月7 など
			const s = timeSchedule[jikanwari.slice(1).slice(0, 1)]
			if (!s)
				throw new Error(
					`'${jikanwari}' の時限の時間割が見つかりませんでした`
				)
			const dow = dayOfWeek.findIndex((v) => v == jikanwari.slice(0, 1))
			if (dow === -1)
				throw new Error(`'${jikanwari}' の曜日が見つかりませんでした`)
			return {
				dayOfWeek: dow,
				...s,
			}
		})
		.reduce((s, cur) => {
			if (s.dayOfWeek !== cur.dayOfWeek)
				throw new Error("別の曜日が指定されています")
			if (s.end.hours <= cur.start.hours) {
				return {
					...s,
					end: cur.end,
				}
			} else {
				return {
					...s,
					start: cur.start,
				}
			}
		})
	return {
		...schedule,
		reccurence,
	}
}

const isKnownYear = (s: string): s is keyof typeof SCHEDULE =>
	Object.keys(SCHEDULE).includes(s)

const main = async (dumpDir: string) => {
	const oauth2Client = new googleapis.google.auth.OAuth2(
		CLIENT_ID,
		CLIENT_SECRET,
		"urn:ietf:wg:oauth:2.0:oob"
	)
	const oauthUrl = oauth2Client.generateAuthUrl({
		access_type: "offline",
		scope: ["https://www.googleapis.com/auth/calendar"],
	})
	console.log(`Please go to ${oauthUrl}`)
	const code = await question("After authorize and enter code: ")

	const { tokens } = await oauth2Client.getToken(code)
	oauth2Client.setCredentials(tokens)

	// calendar 作る
	const calendar = googleapis.google.calendar("v3")
	const {
		data: { id: calendarId },
	} = await calendar.calendars.insert({
		requestBody: {
			summary: "シラバスカレンダー",
			timeZone: "Asia/Tokyo",
		},
		auth: oauth2Client,
	})

	if (!calendarId) throw new Error("ないんだけど？")
	console.log(calendarId)

	const year = schoolYear().toString()
	if (!isKnownYear(year))
		throw new Error(`${year}年の スケジュールが登録されていません`)
	const syllabuses = await readAndParseDumpedSyllabus(
		dumpDir,
		year,
		parsingProgressBar()
	)
	const season = syllabuses[0].digest.学期
	const courses = syllabuses
		.map((s) => {
			// note: スキップされた科目 (R2 K過程 前期 美術) が他になっていた
			if (s.digest["曜日・時限"] === "他") return
			const jigen = s.digest["曜日・時限"].split(",").map((j) => j.trim())
			// FIXME: 型がおかしいのでやめたい
			const 科目番号 = pick(s.contentTree as any, {
				titlePath: CODE_PATH[0],
				contentKey: CODE_PATH[1],
			})!
			return {
				...s.digest,
				"曜日・時限": jigen,
				科目番号,
				calendar: calculateCalendarFromJigen(
					jigen,
					calcReccurence(year, s.digest.学期)
				),
				description: convertSyllabusTreeToMarkdown(
					s.contentTree as any
				),
			}
		})
		.filter(<T>(v: T): v is Exclude<T, undefined> => v !== undefined)

	const startDay = SCHEDULE[year][season].start
	const firstBaseDay = new Date(
		`${startDay[0]}-${startDay[1]
			.toString()
			.padStart(2, "0")}-${startDay[2]
			.toString()
			.padStart(2, "0")}T00:00:00+09:00`
	)

	// TODO: 差分計算に使える情報を入れる (contentTree markdown ?)
	const persisted: {
		calendarId: string
		eventId: string
		courseId: string
		timetableId: string
	}[] = []

	for (const course of courses) {
		const setTime = (d: Date, t: Time, dow: number) => {
			d.setHours(t.hours)
			d.setMinutes(t.minutes)
			const diffDate = dow - d.getDay()
			d.setDate(d.getDate() + (diffDate < 0 ? +7 : 0) + diffDate)
			return d
		}
		const start = setTime(
			new Date(firstBaseDay),
			course.calendar.start,
			course.calendar.dayOfWeek
		)
		const end = setTime(
			new Date(firstBaseDay),
			course.calendar.end,
			course.calendar.dayOfWeek
		)
		const event = {
			summary: `${course.科目}`,
			start: {
				dateTime: start.toISOString(),
				timeZone: "Asia/Tokyo",
			},
			end: {
				dateTime: end.toISOString(),
				timeZone: "Asia/Tokyo",
			},
			recurrence: [course.calendar.reccurence],
			description:
				`時間割コード: ${course.時間割コード}\n\n` + course.description,
		}

		const eventResponse = await calendar.events.insert({
			auth: oauth2Client,
			calendarId,
			requestBody: event,
		})

		persisted.push({
			calendarId,
			eventId: eventResponse.data.id!,
			courseId: course.科目番号,
			timetableId: course.時間割コード,
		})
		console.dir(persisted)
	}

	// TODO: 保存
	console.log(JSON.stringify(persisted, null, 2))
}

main(process.argv[2] || DEFAULT_DUMP_DIRECTORY)
	.then(() => {
		process.exit(0)
	})
	.catch((e) => {
		console.error(e)
		process.exit(1)
	})
