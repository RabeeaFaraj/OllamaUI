// Import AWS SDK clients for S3
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

// Create an S3 client instance
// The region is taken from environment variables (AWS_REGION must be set)
const s3 = new S3Client({
  region: process.env.AWS_REGION
});

// Export the POST handler for the API endpoint
export async function POST(req: Request) {
  // Parse the incoming JSON body from the request
  const { messages, selectedModel, data } = await req.json();

  // Clean messages by removing unnecessary fields (like experimental_attachments)
  const cleanedMessages = messages.map((message: any) => {
    const { experimental_attachments, ...cleanMessage } = message;
    return cleanMessage;
  });

  // Default response if no image is provided
  let message = "Please provide an image for object detection.";

  // Check if the request includes image data
  if (data?.images && data.images.length > 0) {
    try {
      // Take the first image URL from the data
      const imageUrl = data.images[0];

      // Download the image from the provided URL
      const response = await fetch(imageUrl);
      const blob = await response.blob(); // Convert to Blob
      const arrayBuffer = await blob.arrayBuffer(); // Convert Blob to ArrayBuffer
      const buffer = Buffer.from(arrayBuffer); // Convert ArrayBuffer to Node.js Buffer

      // Generate a unique filename for the uploaded image
      const fileKey = `uploads/${Date.now()}-image.jpeg`;

      // Upload the image to S3
      await s3.send(
        new PutObjectCommand({
          Bucket: process.env.S3_BUCKET_NAME!, // S3 bucket name from environment variables
          Key: fileKey,                        // File path/key inside the bucket
          Body: buffer,                        // Image data
          ContentType: "image/jpeg",           // MIME type
        })
      );

      // Call YOLO service for object detection, passing the S3 key
      const predictionResponse = await fetch(
        `http://${process.env.YOLO_SERVICE}/predict?img=${encodeURIComponent(fileKey)}`,
        {
          method: "POST",
        }
      );

      // Throw an error if YOLO service does not respond successfully
      if (!predictionResponse.ok) {
        throw new Error(`Prediction API error: ${predictionResponse.status}`);
      }

      // Parse YOLO prediction results as JSON
      const predictionResult = await predictionResponse.json();

      // Format the detection results for the chat response
      message = `🔍 **Object Detection Results**

**Detection Count:** ${predictionResult.detection_count}
**Detected Objects:** ${predictionResult.labels.join(', ')}
**Prediction ID:** ${predictionResult.prediction_uid}

I've analyzed your image and detected ${predictionResult.detection_count} object(s). The detected objects include: ${predictionResult.labels.join(', ')}.`;

    } catch (error) {
      // Catch and log errors during download, upload, or prediction
      console.error('Object detection error:', error);
      message = `❌ **Object Detection Error**

Sorry, I encountered an error while processing your image: ${error instanceof Error ? error.message : 'Unknown error'}

Please make sure the object detection service is running on localhost:8080.`;
    }
  }

  // --- Prepare a streaming response to send the message back to the client ---
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      // Split the message into separate lines
      const lines = message.split('\n');

      // Send each line as a separate chunk
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        // Add newline character back except for the last line
        const content = i < lines.length - 1 ? line + '\n' : line;
        controller.enqueue(encoder.encode(`0:${JSON.stringify(content)}\n`));
      }

      // Send finish event (metadata about usage and completion)
      controller.enqueue(encoder.encode(`e:${JSON.stringify({
        finishReason: "stop",
        usage: { promptTokens: 10, completionTokens: message.length },
        isContinued: false
      })}\n`));

      // Send done event (final metadata)
      controller.enqueue(encoder.encode(`d:${JSON.stringify({
        finishReason: "stop",
        usage: { promptTokens: 10, completionTokens: message.length }
      })}\n`));

      // Close the stream
      controller.close();
    },
  });

  // Return the streaming response with the proper headers
  return new Response(stream, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'X-Vercel-AI-Data-Stream': 'v1', // Custom header for Vercel streaming AI
    },
  });
}
