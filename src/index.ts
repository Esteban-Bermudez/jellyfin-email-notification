import express, { Request, Response } from "express"
import { generateHtmlTemplate } from "./templates/emailTemplate"

const sgMail = require("@sendgrid/mail")
const nodeMailer = require("nodemailer")

const app = express()
const port = process.env.PORT || 3000

const baseUrl = "/webhook"
const baseRouter = express.Router()

interface TmdbBaseData {
  apiKey: string
  movieUrl: string
  tvUrl: string
  posterUrl: string
  imdbUrl: string
}

interface TmdbResponse {
  genres: string
  homepage: string
  id: number
  overview: string
  posterPath: string
  releaseDate: string
  runtime: number
  tagline: string
  title: string
  movieUrl: string
  imdbUrl: string
}

const tmdbData: TmdbBaseData = {
  apiKey: process.env.TMDB_API_KEY || "",
  movieUrl: "https://www.themoviedb.org/movie/",
  tvUrl: "https://www.themoviedb.org/tv/",
  posterUrl: "https://image.tmdb.org/t/p/original",
  imdbUrl: "https://www.imdb.com/title/",
}

if (!tmdbData.apiKey) {
  console.error("TMDB API Key not found")
  process.exit(1)
}

app.use(express.json())

app.use(baseUrl, baseRouter)

baseRouter.get("/", (req: Request, res: Response) => {
  res.status(200).json({ message: "Webhook is active" })
})

baseRouter.post("/", async (req: Request, res: Response) => {
  printRequest(req)
  if (!bodyContainsTmdbId(req.body)) {
    res.status(400).json({ message: "TMDB ID not found in body" })
    return
  }

  let tmdbResponse
  try {
    tmdbResponse = await fetchTmdbData(req.body.Provider_tmdb)
  } catch (error: any) {
    console.error(error)
    const status = error.status || 500
    const message = error.message || "Error fetching data from TMDB"
    res.status(status).json({ message })
    return
  }
  const formattedResponse = formatTmdbResponse(tmdbResponse)

  if (process.env.MAIL_PROVIDER?.toLowerCase() === "smtp") {
    await sendSMTPEmail(formattedResponse)
  } else {
    await sendSendgridEmail(formattedResponse)
  }
  res.status(200).json(formattedResponse)
})

function printRequest(req: Request) {
  console.log("Headers: ", req.headers)
  console.log("Body: ", req.body)
}

function bodyContainsTmdbId(body: Request["body"]) {
  // Provider_tmdb is the key that contains the TMDB ID
  // This is sent when all details are sent to the webhook with no template and
  // the jellyfin server uses tmdb for metadata.
  if (!body.Provider_tmdb) {
    return false
  }
  return true
}

async function fetchTmdbData(tmdbId: string) {
  const url: string = `https://api.themoviedb.org/3/movie/${tmdbId}?api_key=${tmdbData.apiKey}`
  const tmdbResponse = await fetch(url).then((response) => {
    if (!response.ok) {
      throw {
        status: response.status,
        message: "TMDB ERROR: " + response.statusText,
      }
    }
    return response.json()
  })

  console.log("TMDB Response: ", tmdbResponse)
  return tmdbResponse
}

function formatTmdbResponse(response: any): TmdbResponse {
  return {
    genres: response.genres
      .map((genre: { id: number; name: string }) => genre.name)
      .join(", "),
    homepage: response.homepage,
    id: response.id,
    overview: response.overview,
    posterPath: `${tmdbData.posterUrl}${response.poster_path}`,
    releaseDate: response.release_date,
    runtime: response.runtime,
    tagline: response.tagline,
    title: response.title,
    movieUrl: `${tmdbData.movieUrl}${response.id}`,
    imdbUrl: `${tmdbData.imdbUrl}${response.imdb_id}`,
  }
}

async function sendSendgridEmail(formattedResponse: TmdbResponse) {
  sgMail.setApiKey(process.env.SENDGRID_API_KEY)

  const receiverEmails = (process.env.SENDGRID_RECEIVER_EMAIL || "")
  .replace(/\s/g, "")
  .split(",")
  .map((email: string) => ({ email: email }))

  const msg = {
    from: {
      email: process.env.SENDGRID_SENDER_EMAIL,
    },
    personalizations: [
      {
        to: receiverEmails, // array of objects with email key and value
        dynamic_template_data: {
          title: formattedResponse.title,
          releaseDate: formattedResponse.releaseDate,
          overview: formattedResponse.overview,
          posterPath: formattedResponse.posterPath,
          movieUrl: formattedResponse.movieUrl,
          imdbUrl: formattedResponse.imdbUrl,
        },
      },
    ],
    templateId: process.env.SENDGRID_TEMPLATE_ID,
  }
  await sgMail.send(msg)
}

async function sendSMTPEmail(formattedResponse: TmdbResponse) {
  const transporter = nodeMailer.createTransport({
    host: process.env.SMTP_HOST,
    port: process.env.SMTP_PORT || "587",
    secure: false,
    auth: {
      user: process.env.SMTP_AUTH_USER,
      pass: process.env.SMTP_AUTH_PASSWORD,
    },
  })

  const mailOptions = {
    from: process.env.SMTP_SENDER_EMAIL,
    to: process.env.SMTP_RECEIVER_EMAIL,
    subject:
      "A new movie has been added to Jellyfin " +
      formattedResponse.title +
      ` (${formattedResponse.releaseDate})`,
    html: generateHtmlTemplate(formattedResponse),
  }

  await transporter.sendMail(mailOptions, (error: any, info: any) => {
    if (error) {
      console.error(error)
    } else {
      console.log("Email sent: " + info.response)
    }
  })
}

app.listen(port, () => {
  console.log(`Server running at http://0.0.0.0:${port + baseUrl}`)
})
